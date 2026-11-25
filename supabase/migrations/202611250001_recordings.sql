-- Enable MP4 in the existing private, 20 MiB attachment bucket.
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
      or coalesce(item->>'mime', '') not in ('image/webp', 'video/mp4')
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
    if item->>'mime' = 'video/mp4'
      and ((item->>'size')::numeric < 16
        or (item->>'size')::numeric <> trunc((item->>'size')::numeric)
        or (item->>'width')::numeric > 1920
        or (item->>'width')::numeric <> trunc((item->>'width')::numeric)
        or (item->>'height')::numeric > 1080
        or (item->>'height')::numeric <> trunc((item->>'height')::numeric)) then
      return false;
    end if;
    perform (item->>'createdAt')::timestamptz;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

update storage.buckets
set allowed_mime_types = array['image/webp', 'video/mp4']
where id = 'note-images';

alter policy "Owners can upload their images" on storage.objects
  with check (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(webp|mp4)$'
  );

-- Clients can keep recordings queued against projects using the earlier schema.
create or replace function public.supports_recording_sync()
returns boolean
language sql
stable
set search_path = ''
as $$ select true $$;

revoke all on function public.supports_recording_sync() from public, anon, authenticated;
grant execute on function public.supports_recording_sync() to authenticated;

notify pgrst, 'reload schema';
commit;
