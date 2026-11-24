// Runs the real migration in embedded PostgreSQL, with minimal auth/storage
// fixtures standing in for the platform-managed Supabase schemas.
// Run with npm run test:db.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const ownerA = '10000000-0000-4000-8000-000000000001'
const ownerB = '10000000-0000-4000-8000-000000000002'
const noteId = '20000000-0000-4000-8000-000000000001'
const deviceId = '30000000-0000-4000-8000-000000000001'
const versionA = '40000000-0000-4000-8000-000000000001'
const versionB = '40000000-0000-4000-8000-000000000002'
const versionC = '40000000-0000-4000-8000-000000000003'
const content = {
  title: '보존할 메모', body: '원본 내용', pinned: false, tags: ['테스트'],
  createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z',
  deletedAt: null, attachments: [],
}

test('note CAS, owner isolation, malformed data and image/subscription access', async (t) => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create schema storage;
      create table auth.users (id uuid primary key);
      insert into auth.users values ('${ownerA}'), ('${ownerB}');
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      create table storage.buckets (
        id text primary key, name text not null, public boolean not null,
        file_size_limit bigint, allowed_mime_types text[]
      );
      create table storage.objects (bucket_id text, name text);
      alter table storage.objects enable row level security;
      grant usage on schema public, auth, storage to anon, authenticated, service_role;
      grant all on storage.objects to authenticated, service_role;
      create function storage.foldername(text) returns text[] language sql immutable as $$
        select case when position('/' in $1) > 0
          then string_to_array(regexp_replace($1, '/[^/]*$', ''), '/') else '{}'::text[] end
      $$;
      create function storage.filename(text) returns text language sql immutable as $$
        select regexp_replace($1, '^.*/', '')
      $$;
    `)
    await db.exec(await readFile(new URL('../migrations/202611240001_initial.sql', import.meta.url), 'utf8'))
    const asOwner = async (owner) => {
      await db.exec('reset role; set role authenticated;')
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner])
    }
    const save = async (data, version, expectedVersion, id = noteId) => {
      const result = await db.query('select public.save_note($1, $2::jsonb, $3, $4, $5) as result',
        [id, JSON.stringify(data), version, expectedVersion, deviceId])
      return result.rows[0].result
    }

    await t.test('anonymous callers cannot read notes or invoke the write RPC', async () => {
      await db.exec('set role anon;')
      await assert.rejects(db.query('select * from public.notes'), /permission denied/)
      await assert.rejects(save(content, versionA, null), /permission denied/)
    })

    let firstSaved
    await t.test('first save succeeds; an identical retry preserves its server timestamp', async () => {
      await asOwner(ownerA)
      firstSaved = await save(content, versionA, null)
      assert.equal(firstSaved.status, 'saved')
      assert.equal(firstSaved.note.owner_id, ownerA)
      const retried = await save(content, versionA, null)
      assert.deepEqual(retried, firstSaved)
      await assert.rejects(save({ ...content, body: '다른 내용' }, versionA, versionA), /version cannot be reused/)
    })

    await t.test('stale updates return the winning revision without overwriting it', async () => {
      const conflict = await save({ ...content, body: 'stale' }, versionB, null)
      assert.equal(conflict.status, 'conflict')
      assert.equal(conflict.note.data.body, content.body)
      const updated = await save({ ...content, body: '새 내용' }, versionB, versionA)
      assert.equal(updated.status, 'saved')
      const stale = await save({ ...content, body: '늦은 편집' }, versionC, versionA)
      assert.equal(stale.status, 'conflict')
      assert.equal(stale.note.version, versionB)
      assert.equal(stale.note.data.body, '새 내용')
      await assert.rejects(save(content, versionC, versionA, '20000000-0000-4000-8000-000000000099'), /Remote note missing/)
    })

    await t.test('a second owner cannot see or directly overwrite another owner’s note', async () => {
      await asOwner(ownerB)
      assert.equal((await db.query('select * from public.notes')).rows.length, 0)
      await assert.rejects(db.query('update public.notes set version = $1 where id = $2', [versionC, noteId]), /permission denied/)
      const separate = await save({ ...content, body: '두 번째 계정' }, versionA, null)
      assert.equal(separate.note.owner_id, ownerB)
      await asOwner(ownerA)
      assert.equal((await db.query('select data from public.notes')).rows[0].data.body, '새 내용')
    })

    await t.test('malformed notes are rejected before storage', async () => {
      await assert.rejects(save({ ...content, body: null }, versionC, versionB), /Invalid note data/)
      await assert.rejects(save({ ...content, createdAt: 'not-a-date' }, versionC, versionB), /Invalid note data/)
      await assert.rejects(save({ ...content, attachments: [{ id: 'bad' }] }, versionC, versionB), /Invalid note data/)
    })

    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    }
    await t.test('subscriptions require complete keys and cannot cross owner boundaries', async () => {
      await assert.rejects(db.query('insert into public.push_subscriptions(owner_id,device_id,subscription) values ($1,$2,$3::jsonb)',
        [ownerA, deviceId, '{}']), /check constraint/)
      await db.query('insert into public.push_subscriptions(owner_id,device_id,subscription) values ($1,$2,$3::jsonb)',
        [ownerA, deviceId, JSON.stringify(subscription)])
      await asOwner(ownerB)
      assert.equal((await db.query('select * from public.push_subscriptions')).rows.length, 0)
      await assert.rejects(db.query('insert into public.push_subscriptions(owner_id,device_id,subscription) values ($1,$2,$3::jsonb)',
        [ownerA, versionC, JSON.stringify(subscription)]), /row-level security/)
      await db.query('delete from public.push_subscriptions where owner_id = $1', [ownerA])
      await asOwner(ownerA)
      assert.equal((await db.query('select * from public.push_subscriptions')).rows.length, 1)
    })

    await t.test('private immutable WebP images are readable only by their owner', async () => {
      const imagePath = `${ownerA}/${noteId}.webp`
      await db.query('insert into storage.objects values ($1,$2)', ['note-images', imagePath])
      await asOwner(ownerB)
      assert.equal((await db.query('select * from storage.objects')).rows.length, 0)
      await assert.rejects(db.query('insert into storage.objects values ($1,$2)', ['note-images', imagePath]), /row-level security/)
      await asOwner(ownerA)
      await assert.rejects(db.query('insert into storage.objects values ($1,$2)', ['note-images', `${ownerA}/nested/${noteId}.webp`]), /row-level security/)
      await assert.rejects(db.query('insert into storage.objects values ($1,$2)', ['note-images', `${ownerA}/${noteId}.png`]), /row-level security/)
      await db.query('update storage.objects set name = $1', [`${ownerA}/${versionA}.webp`])
      assert.equal((await db.query('select name from storage.objects')).rows[0].name, imagePath)
      await db.query('delete from storage.objects where name = $1', [imagePath])
      assert.equal((await db.query('select * from storage.objects')).rows.length, 0)
    })
  } finally {
    await db.close()
  }
})
