-- Apply once through the Supabase SQL editor or `supabase db push`.
-- Application data belongs to the signed-in owner. Clients write notes only
-- through save_note(), so they cannot bypass the version comparison.

begin;

create or replace function public.is_valid_note_data(p_data jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if jsonb_typeof(p_data) is distinct from 'object'
    or octet_length(p_data::text) > 1500000
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or length(p_data->>'title') > 500
    or jsonb_typeof(p_data->'body') is distinct from 'string'
    or length(p_data->>'body') > 1000000
    or jsonb_typeof(p_data->'pinned') is distinct from 'boolean'
    or jsonb_typeof(p_data->'tags') is distinct from 'array'
    or jsonb_typeof(p_data->'attachments') is distinct from 'array'
    or jsonb_typeof(p_data->'createdAt') is distinct from 'string'
    or jsonb_typeof(p_data->'updatedAt') is distinct from 'string'
    or not (p_data ? 'deletedAt')
    or jsonb_typeof(p_data->'deletedAt') not in ('string', 'null') then
    return false;
  end if;
  if jsonb_array_length(p_data->'tags') > 50
    or jsonb_array_length(p_data->'attachments') > 100 then
    return false;
  end if;
  perform (p_data->>'createdAt')::timestamptz;
  perform (p_data->>'updatedAt')::timestamptz;
  if p_data->>'deletedAt' is not null then
    perform (p_data->>'deletedAt')::timestamptz;
  end if;
  for item in select value from jsonb_array_elements(p_data->'tags') loop
    if jsonb_typeof(item) is distinct from 'string'
      or length(item #>> '{}') > 100 then
      return false;
    end if;
  end loop;
  for item in select value from jsonb_array_elements(p_data->'attachments') loop
    if jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or (item->>'id') !~ uuid_pattern
      or jsonb_typeof(item->'name') is distinct from 'string'
      or length(item->>'name') > 500
      or item->>'mime' is distinct from 'image/webp'
      or jsonb_typeof(item->'size') is distinct from 'number'
      or (item->>'size')::numeric < 0
      or (item->>'size')::numeric > 20971520
      or jsonb_typeof(item->'width') is distinct from 'number'
      or (item->>'width')::numeric <= 0
      or jsonb_typeof(item->'height') is distinct from 'number'
      or (item->>'height')::numeric <= 0
      or jsonb_typeof(item->'createdAt') is distinct from 'string' then
      return false;
    end if;
    perform (item->>'createdAt')::timestamptz;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.is_valid_note_data(jsonb) from public, anon, authenticated;

create table public.notes (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  data jsonb not null check (public.is_valid_note_data(data)),
  version uuid not null,
  updated_at timestamptz not null default now(),
  origin_device_id uuid not null,
  primary key (owner_id, id)
);

create index notes_owner_updated_idx on public.notes (owner_id, updated_at, id);
alter table public.notes enable row level security;

revoke all on public.notes from public, anon, authenticated;
grant select on public.notes to authenticated;
grant all on public.notes to service_role;

create policy "Owners can read their notes"
  on public.notes for select to authenticated
  using (owner_id = (select auth.uid()));

-- Realtime only invalidates the client's local view; the authenticated sync
-- fetch remains authoritative. Supabase already provides this publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notes'
    ) then
    alter publication supabase_realtime add table public.notes;
  end if;
end;
$$;

create or replace function public.save_note(
  p_id uuid,
  p_data jsonb,
  p_version uuid,
  p_expected_version uuid,
  p_origin_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid := auth.uid();
  stored public.notes%rowtype;
begin
  if current_owner is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_id is null or p_version is null or p_origin_device_id is null
    or not public.is_valid_note_data(p_data) then
    raise exception 'Invalid note data' using errcode = '22023';
  end if;

  -- A row lock alone cannot protect the first INSERT. Every writer for this
  -- owner/note pair takes the same transaction-scoped lock, including retries.
  perform pg_advisory_xact_lock(hashtextextended(current_owner::text || ':' || p_id::text, 0));
  select * into stored from public.notes
    where owner_id = current_owner and id = p_id for update;

  if found then
    if stored.version = p_version then
      if stored.data = p_data and stored.origin_device_id = p_origin_device_id then
        return jsonb_build_object('status', 'saved', 'note', to_jsonb(stored));
      end if;
      raise exception 'A version cannot be reused for different content' using errcode = '22023';
    end if;
    if p_expected_version is distinct from stored.version then
      return jsonb_build_object('status', 'conflict', 'note', to_jsonb(stored));
    end if;
    update public.notes set
      data = p_data,
      version = p_version,
      origin_device_id = p_origin_device_id,
      updated_at = clock_timestamp()
    where owner_id = current_owner and id = p_id
    returning * into stored;
  else
    if p_expected_version is not null then
      -- Preserve the local dirty note when a previously synced remote row was
      -- removed or this client was pointed at a different project.
      raise exception 'Remote note missing; verify your sync configuration' using errcode = '40001';
    end if;
    insert into public.notes (owner_id, id, data, version, origin_device_id)
      values (current_owner, p_id, p_data, p_version, p_origin_device_id)
      returning * into stored;
  end if;
  return jsonb_build_object('status', 'saved', 'note', to_jsonb(stored));
end;
$$;

revoke all on function public.save_note(uuid, jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function public.save_note(uuid, jsonb, uuid, uuid, uuid) to authenticated;

create table public.push_subscriptions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  subscription jsonb not null,
  label text not null default '' check (length(label) <= 100),
  updated_at timestamptz not null default now(),
  primary key (owner_id, device_id),
  constraint valid_push_subscription check ((
    jsonb_typeof(subscription) = 'object'
    and octet_length(subscription::text) <= 8192
    and jsonb_typeof(subscription->'endpoint') = 'string'
    and length(subscription->>'endpoint') <= 2048
    and subscription->>'endpoint' ~ '^https://'
    and jsonb_typeof(subscription->'keys') = 'object'
    and jsonb_typeof(subscription->'keys'->'p256dh') = 'string'
    and jsonb_typeof(subscription->'keys'->'auth') = 'string'
  ) is true)
);

create or replace function public.touch_push_subscription()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.touch_push_subscription() from public, anon, authenticated;

create trigger touch_push_subscription before update on public.push_subscriptions
  for each row execute function public.touch_push_subscription();

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

create policy "Owners can read their subscriptions"
  on public.push_subscriptions for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Owners can register their subscriptions"
  on public.push_subscriptions for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Owners can update their subscriptions"
  on public.push_subscriptions for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "Owners can remove their subscriptions"
  on public.push_subscriptions for delete to authenticated
  using (owner_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', false, 20971520, array['image/webp']);

create policy "Owners can read their images"
  on storage.objects for select to authenticated
  using (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "Owners can upload their images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.webp$'
  );
-- Images are immutable. A replacement gets a fresh UUID, which also makes
-- interrupted/retried note syncs safe. There is intentionally no UPDATE policy.
create policy "Owners can remove their images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid()::text));

comment on table public.notes is 'Owner-only memo revisions; write through save_note RPC.';
comment on table public.push_subscriptions is 'Owner-only Web Push subscriptions; never expose to anonymous callers.';

commit;
