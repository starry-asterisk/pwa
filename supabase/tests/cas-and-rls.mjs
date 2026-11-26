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
    await t.test('recording migration preserves private immutable attachments and accepts valid MP4 notes', async () => {
      await db.exec('reset role')
      await db.exec(await readFile(new URL('../migrations/202611250001_recordings.sql', import.meta.url), 'utf8'))
      const bucket = (await db.query("select * from storage.buckets where id = 'note-images'")).rows[0]
      assert.equal(bucket.public, false)
      assert.equal(Number(bucket.file_size_limit), 20971520)
      assert.deepEqual(bucket.allowed_mime_types, ['image/webp', 'video/mp4'])

      await db.exec('set role anon')
      await assert.rejects(db.query('select public.supports_recording_sync()'), /permission denied/)
      await asOwner(ownerA)
      assert.equal((await db.query('select public.supports_recording_sync() as supported')).rows[0].supported, true)
      const recording = {
        id: deviceId, name: 'recording.mp4', mime: 'video/mp4', size: 4096,
        width: 1920, height: 1080, createdAt: content.createdAt,
      }
      for (const invalid of [{ width: 2000 }, { size: 20971521 }, { height: 900.5 }, { mime: 'text/html' }]) {
        await assert.rejects(save({ ...content, attachments: [{ ...recording, ...invalid }] }, versionC, versionB), /Invalid note data/)
      }
      const path = ownerA + '/' + recording.id + '.mp4'
      await db.query('insert into storage.objects values ($1,$2)', ['note-images', path])
      await assert.rejects(db.query('insert into storage.objects values ($1,$2)', ['note-images', ownerA + '/nested/' + recording.id + '.mp4']), /row-level security/)
      const saved = await save({ ...content, attachments: [recording] }, versionC, versionB)
      assert.equal(saved.note.data.attachments[0].mime, 'video/mp4')
      await asOwner(ownerB)
      assert.equal((await db.query('select * from storage.objects')).rows.length, 0)
      await assert.rejects(db.query('insert into storage.objects values ($1,$2)', ['note-images', path]), /row-level security/)
      await asOwner(ownerA)
      assert.equal((await db.query('select name from storage.objects')).rows[0].name, path)
    })

    await t.test('permanent deletion keeps no memo content and cannot cross account boundaries', async () => {
      await db.exec('reset role')
      await db.exec('create publication supabase_realtime for table public.notes')
      await db.exec(await readFile(new URL('../migrations/202611260001_permanent_delete.sql', import.meta.url), 'utf8'))
      assert.equal((await db.query("select count(*)::int as count from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'note_tombstones'")).rows[0].count, 1)

      await db.exec('set role anon')
      await assert.rejects(db.query('select * from public.note_tombstones'), /permission denied/)
      await assert.rejects(db.query('select * from public.note_attachment_gc'), /permission denied/)
      await assert.rejects(db.query('select * from public.pending_note_attachment_gc'), /permission denied/)
      await assert.rejects(db.query('select public.purge_notes($1::uuid[])', [[noteId]]), /permission denied/)
      await assert.rejects(db.query('select public.ack_note_attachment_gc($1::text[])', [[]]), /permission denied/)

      const sharedRecording = { id: deviceId, name: 'clip.mp4', mime: 'video/mp4', size: 4096,
        width: 1920, height: 1080, createdAt: content.createdAt }
      const copyId = '20000000-0000-4000-8000-000000000002'
      const orphanId = '20000000-0000-4000-8000-000000000003'
      const lateId = '20000000-0000-4000-8000-000000000004'
      const unusedId = '20000000-0000-4000-8000-000000000005'
      const offlineNoteId = '20000000-0000-4000-8000-000000000006'
      const inFlightId = '20000000-0000-4000-8000-000000000007'
      const sharedName = ownerA + '/' + sharedRecording.id + '.mp4'
      const orphanName = ownerA + '/' + orphanId + '.webp'
      const lateName = ownerA + '/' + lateId + '.webp'
      const unusedName = ownerA + '/' + unusedId + '.webp'
      const inFlightName = ownerA + '/' + inFlightId + '.webp'
      const otherOwnerName = ownerB + '/' + sharedRecording.id + '.mp4'
      const image = (id) => ({ id, name: 'image.webp', mime: 'image/webp', size: 128,
        width: 20, height: 20, createdAt: content.createdAt })
      const upload = (name) => db.query("insert into storage.objects values ('note-images', $1)", [name])
      // The fixture represents only Storage metadata. The app uses the Storage API.
      const remove = (name) => db.query('delete from storage.objects where name = $1 returning name', [name])
      const purge = async (ids, names = []) => (await db.query(
        'select public.purge_notes($1::uuid[], $2::text[]) as result', [ids, names])).rows[0].result
      const ack = async (names) => (await db.query(
        'select public.ack_note_attachment_gc($1::text[]) as result', [names])).rows[0].result
      const pending = async () => (await db.query('select object_name from public.pending_note_attachment_gc order by object_name')).rows.map(row => row.object_name)

      await asOwner(ownerB)
      await upload(otherOwnerName)
      await asOwner(ownerA)
      await assert.rejects(purge([]), /Invalid note purge batch/)
      await assert.rejects(purge([null]), /Invalid note purge batch/)
      await assert.rejects(db.query('delete from public.notes'), /permission denied/)
      await assert.rejects(db.query('delete from public.note_tombstones'), /permission denied/)
      await assert.rejects(db.query('update public.note_attachment_gc set cleaned_at = now()'), /permission denied/)

      const copy = await save({ ...content, deletedAt: content.updatedAt, attachments: [sharedRecording] }, versionA, null, copyId)
      assert.equal(copy.status, 'saved')
      await upload(orphanName)
      assert.deepEqual(await purge([noteId, noteId, offlineNoteId], [otherOwnerName, sharedName, orphanName, inFlightName]), [
        { id: noteId, status: 'purged' },
        { id: offlineNoteId, status: 'purged' },
      ])
      assert.deepEqual((await db.query('select id from public.notes')).rows, [{ id: copyId }])
      const tombstones = (await db.query('select * from public.note_tombstones order by id')).rows
      assert.deepEqual(tombstones.map(row => row.id), [noteId, offlineNoteId])
      assert.deepEqual(Object.keys(tombstones[0]).sort(), ['deleted_at', 'id', 'owner_id'])
      assert.deepEqual(await purge([noteId]), [{ id: noteId, status: 'purged' }])
      assert.deepEqual((await db.query('select * from public.note_tombstones order by id')).rows, tombstones)
      assert.deepEqual(await pending(), [orphanName, inFlightName])
      assert.deepEqual((await remove(sharedName)).rows, [])
      assert.equal(await ack([orphanName, inFlightName]), 1)
      assert.deepEqual(await pending(), [orphanName])

      await asOwner(ownerB)
      assert.deepEqual((await db.query('select id from public.notes')).rows, [{ id: noteId }])
      assert.deepEqual((await db.query('select * from public.note_tombstones')).rows, [])
      assert.deepEqual(await pending(), [])
      assert.equal(await ack([orphanName]), 0)
      assert.deepEqual((await remove(orphanName)).rows, [])
      assert.deepEqual((await db.query('select name from storage.objects')).rows, [{ name: otherOwnerName }])

      await asOwner(ownerA)
      await upload(lateName)
      assert.deepEqual(await save({ ...content, attachments: [sharedRecording, image(lateId)] }, versionB, versionC), { status: 'purged' })
      assert.deepEqual(await save(content, versionB, null, offlineNoteId), { status: 'purged' })
      assert.deepEqual(await pending(), [orphanName, lateName].sort())
      assert.equal((await save({ ...content, body: 'surviving copy' }, versionB, versionC, copyId)).status, 'conflict')
      assert.deepEqual(await purge([copyId]), [{ id: copyId, status: 'purged' }])
      assert.deepEqual(await pending(), [orphanName, lateName, sharedName].sort())

      await assert.rejects(upload(sharedName), /row-level security/)
      assert.deepEqual(await save({ ...content, attachments: [sharedRecording, image(orphanId)] }, versionA, null, unusedId), {
        status: 'attachment_purged',
        object_names: [orphanName, sharedName].sort(),
      })
      for (const name of [sharedName, orphanName, lateName]) {
        assert.deepEqual((await remove(name)).rows, [{ name }])
      }
      assert.equal(await ack([sharedName, orphanName, lateName, otherOwnerName]), 3)
      assert.equal(await ack([sharedName]), 0)
      assert.deepEqual(await pending(), [])
      await assert.rejects(upload(sharedName), /row-level security/)
      await assert.rejects(upload(lateName), /row-level security/)
      assert.deepEqual(await save({ ...content, attachments: [image(lateId)] }, versionA, null, unusedId), {
        status: 'attachment_purged', object_names: [lateName],
      })
      await upload(unusedName)
      assert.equal((await save({ ...content, attachments: [image(unusedId)] }, versionA, null, unusedId)).status, 'saved')

      await assert.rejects(upload(inFlightName), /row-level security/)
      // Simulate Storage finalizing an upload authorized before retirement.
      await db.exec('reset role')
      await upload(inFlightName)
      await asOwner(ownerB)
      assert.deepEqual(await pending(), [])
      await asOwner(ownerA)
      assert.deepEqual(await pending(), [inFlightName])
      assert.deepEqual((await remove(inFlightName)).rows, [{ name: inFlightName }])
      assert.equal(await ack([inFlightName]), 0)
      assert.deepEqual(await pending(), [])
    })
  } finally {
    await db.close()
  }
})
