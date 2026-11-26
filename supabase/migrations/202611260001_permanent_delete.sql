-- Permanently delete notes and retire any now-unreferenced private attachments.
begin;

create table public.note_tombstones (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  deleted_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, id)
);

create table public.note_attachment_gc (
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_name text not null,
  cleaned_at timestamptz,
  primary key (owner_id, object_name)
);

create index note_attachment_gc_pending_idx
  on public.note_attachment_gc (owner_id, object_name) where cleaned_at is null;
create index notes_attachment_lookup_idx
  on public.notes using gin ((data->'attachments') jsonb_path_ops);

alter table public.note_tombstones enable row level security;
alter table public.note_attachment_gc enable row level security;
revoke all on public.note_tombstones, public.note_attachment_gc from public, anon, authenticated;
grant select on public.note_tombstones, public.note_attachment_gc to authenticated;
grant all on public.note_tombstones, public.note_attachment_gc to service_role;

create policy "Owners can read their note tombstones"
  on public.note_tombstones for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Owners can read their attachment cleanup"
  on public.note_attachment_gc for select to authenticated
  using (owner_id = (select auth.uid()));

-- A Storage upload that was already in flight can finish after a cleanup
-- acknowledgement. Listing those retired paths again makes cleanup retryable.
create view public.pending_note_attachment_gc with (security_invoker = true) as
select retired.owner_id, retired.object_name
from public.note_attachment_gc as retired
where retired.cleaned_at is null or exists (
  select 1 from storage.objects as object
  where object.bucket_id = 'note-images' and object.name = retired.object_name
);

revoke all on public.pending_note_attachment_gc from public, anon, authenticated;
grant select on public.pending_note_attachment_gc to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'note_tombstones'
    ) then
    alter publication supabase_realtime add table public.note_tombstones;
  end if;
end;
$$;

create schema moa_private;
revoke all on schema moa_private from public, anon, authenticated;
grant usage on schema moa_private to authenticated;

-- Saves, purges and uploads use the same owner lock so a path retirement
-- cannot overlap with a new reference or the creation of a Storage object.
create function moa_private.lock_note_owner(p_owner uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('moa:note-owner:' || p_owner::text, 0));
$$;

create function moa_private.note_attachment_paths(p_owner uuid, p_data jsonb)
returns table (object_name text)
language sql
immutable
set search_path = ''
as $$
  select p_owner::text || '/' || (attachment->>'id')
    || case when attachment->>'mime' = 'video/mp4' then '.mp4' else '.webp' end
  from jsonb_array_elements(p_data->'attachments') as item(attachment);
$$;

-- Only called by writers holding the owner lock. Conflict copies and notes
-- in Trash remain live references until they themselves are removed.
create function moa_private.retire_note_attachments(
  p_owner uuid,
  p_names text[],
  p_only_uploaded boolean
)
returns void
language sql
set search_path = ''
as $$
  insert into public.note_attachment_gc (owner_id, object_name)
  select distinct p_owner, candidate.object_name
  from unnest(p_names) as candidate(object_name)
  where split_part(candidate.object_name, '/', 1) = p_owner::text
    and candidate.object_name ~ '^[^/]+/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(webp|mp4)$'
    and (
      not p_only_uploaded or exists (
        select 1 from storage.objects as object
        where object.bucket_id = 'note-images' and object.name = candidate.object_name
      )
    )
    and not exists (
      select 1 from public.notes as note
      where note.owner_id = p_owner and note.data->'attachments' @> jsonb_build_array(jsonb_build_object(
        'id', split_part(split_part(candidate.object_name, '/', 2), '.', 1),
        'mime', case when right(candidate.object_name, 4) = '.mp4' then 'video/mp4' else 'image/webp' end
      ))
    )
  on conflict do nothing;
$$;

create function moa_private.note_attachment_upload_allowed(p_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid := auth.uid();
begin
  if current_owner is null or split_part(p_name, '/', 1) is distinct from current_owner::text then
    return false;
  end if;
  perform moa_private.lock_note_owner(current_owner);
  return not exists (
    select 1 from public.note_attachment_gc
    where owner_id = current_owner and object_name = p_name
  );
end;
$$;

revoke all on function moa_private.lock_note_owner(uuid) from public, anon, authenticated;
revoke all on function moa_private.note_attachment_paths(uuid, jsonb) from public, anon, authenticated;
revoke all on function moa_private.retire_note_attachments(uuid, text[], boolean) from public, anon, authenticated;
revoke all on function moa_private.note_attachment_upload_allowed(text) from public, anon, authenticated;
grant execute on function moa_private.note_attachment_upload_allowed(text) to authenticated;

alter policy "Owners can upload their images" on storage.objects
  with check (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(webp|mp4)$'
    and moa_private.note_attachment_upload_allowed(name)
  );

-- The client removes the object through the Storage API. The queue entry
-- persists as a path guard after deletion, so old uploads cannot recreate it.
alter policy "Owners can remove their images" on storage.objects
  using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and exists (
      select 1 from public.note_attachment_gc as retired
      where retired.owner_id = (select auth.uid()) and retired.object_name = storage.objects.name
    )
  );

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
  attachment_paths text[];
  retired_paths text[];
begin
  if current_owner is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_id is null or p_version is null or p_origin_device_id is null
    or not public.is_valid_note_data(p_data) then
    raise exception 'Invalid note data' using errcode = '22023';
  end if;

  perform moa_private.lock_note_owner(current_owner);
  select array_agg(distinct object_name) into attachment_paths
  from moa_private.note_attachment_paths(current_owner, p_data);

  if exists (select 1 from public.note_tombstones where owner_id = current_owner and id = p_id) then
    -- Older clients may have uploaded an attachment before attempting to
    -- sync this deleted note. Retire such paths only if no note uses them.
    perform moa_private.retire_note_attachments(current_owner, attachment_paths, true);
    return jsonb_build_object('status', 'purged');
  end if;

  select * into stored from public.notes
    where owner_id = current_owner and id = p_id for update;

  if stored.id is not null then
    if stored.version = p_version then
      if stored.data = p_data and stored.origin_device_id = p_origin_device_id then
        return jsonb_build_object('status', 'saved', 'note', to_jsonb(stored));
      end if;
      raise exception 'A version cannot be reused for different content' using errcode = '22023';
    end if;
    if p_expected_version is distinct from stored.version then
      return jsonb_build_object('status', 'conflict', 'note', to_jsonb(stored));
    end if;
  elsif p_expected_version is not null then
    raise exception 'Remote note missing; verify your sync configuration' using errcode = '40001';
  end if;

  select array_agg(object_name order by object_name) into retired_paths
  from public.note_attachment_gc
  where owner_id = current_owner and object_name = any(attachment_paths);
  if retired_paths is not null then
    return jsonb_build_object('status', 'attachment_purged', 'object_names', to_jsonb(retired_paths));
  end if;

  if stored.id is not null then
    update public.notes set
      data = p_data,
      version = p_version,
      origin_device_id = p_origin_device_id,
      updated_at = clock_timestamp()
    where owner_id = current_owner and id = p_id
    returning * into stored;
  else
    insert into public.notes (owner_id, id, data, version, origin_device_id)
      values (current_owner, p_id, p_data, p_version, p_origin_device_id)
      returning * into stored;
  end if;
  return jsonb_build_object('status', 'saved', 'note', to_jsonb(stored));
end;
$$;

create function public.purge_notes(p_ids uuid[], p_attachment_names text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid := auth.uid();
  attachment_paths text[];
begin
  if current_owner is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if coalesce(cardinality(p_ids), 0) not between 1 and 200
    or array_position(p_ids, null) is not null
    or coalesce(cardinality(p_attachment_names), 0) > 200 then
    raise exception 'Invalid note purge batch' using errcode = '22023';
  end if;

  perform moa_private.lock_note_owner(current_owner);
  -- A confirmed permanent deletion also wins over a pending offline save,
  -- even if the note was not yet in Trash on the server.
  insert into public.note_tombstones (owner_id, id)
    select current_owner, unnest(p_ids) on conflict do nothing;

  with removed as (
    delete from public.notes where owner_id = current_owner and id = any(p_ids) returning data
  )
  select array_agg(distinct path.object_name) into attachment_paths
  from removed cross join lateral moa_private.note_attachment_paths(current_owner, removed.data) as path;

  perform moa_private.retire_note_attachments(current_owner, attachment_paths, false);
  perform moa_private.retire_note_attachments(current_owner, p_attachment_names, false);

  return (
    select jsonb_agg(jsonb_build_object('id', input.id, 'status', 'purged') order by input.id)
    from (select distinct unnest(p_ids) as id) as input
  );
end;
$$;

create function public.ack_note_attachment_gc(p_names text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid := auth.uid();
  affected integer;
begin
  if current_owner is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if coalesce(cardinality(p_names), 0) not between 1 and 200 then
    raise exception 'Invalid attachment cleanup batch' using errcode = '22023';
  end if;

  update public.note_attachment_gc as retired
  set cleaned_at = clock_timestamp()
  where retired.owner_id = current_owner and retired.object_name = any(p_names)
    and retired.cleaned_at is null and not exists (
      select 1 from storage.objects as object
      where object.bucket_id = 'note-images' and object.name = retired.object_name
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.purge_notes(uuid[], text[]) from public, anon, authenticated;
revoke all on function public.ack_note_attachment_gc(text[]) from public, anon, authenticated;
grant execute on function public.purge_notes(uuid[], text[]) to authenticated;
grant execute on function public.ack_note_attachment_gc(text[]) to authenticated;

comment on table public.note_tombstones is 'Owner-only permanent deletion markers. Contains no note content.';
comment on table public.note_attachment_gc is 'Owner-only Storage cleanup queue and permanent guard against reusing retired paths.';

notify pgrst, 'reload schema';
commit;
