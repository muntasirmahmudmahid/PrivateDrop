-- PrivateDrop backend setup for Supabase
-- Run this entire file in Supabase Dashboard > SQL Editor.
-- The bucket is private. Only authenticated users can access the shared inbox.
create extension if not exists pgcrypto;

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  original_name text not null check (char_length(original_name) between 1 and 255),
  size_bytes bigint not null check (size_bytes >= 0),
  storage_path text not null unique,
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  download_claimed_at timestamptz
);

alter table public.files enable row level security;

drop policy if exists "Authenticated users can list shared files" on public.files;
create policy "Authenticated users can list shared files"
on public.files for select to authenticated using (true);

drop policy if exists "Authenticated users can upload metadata" on public.files;
create policy "Authenticated users can upload metadata"
on public.files for insert to authenticated
with check (uploaded_by = (select auth.uid()));

drop policy if exists "Authenticated users can delete metadata" on public.files;
create policy "Authenticated users can delete metadata"
on public.files for delete to authenticated using (true);

-- Prevent clients from editing file ownership, path, or metadata after insert.
revoke update on public.files from anon, authenticated;
grant select, insert, delete on public.files to authenticated;
grant usage on schema public to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-files', 'private-files', false, 52428800, null)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "Signed-in users can upload private files" on storage.objects;
create policy "Signed-in users can upload private files"
on storage.objects for insert to authenticated
with check (bucket_id = 'private-files');

drop policy if exists "Signed-in users can download private files" on storage.objects;
create policy "Signed-in users can download private files"
on storage.objects for select to authenticated
using (bucket_id = 'private-files');

drop policy if exists "Signed-in users can delete private files" on storage.objects;
create policy "Signed-in users can delete private files"
on storage.objects for delete to authenticated
using (bucket_id = 'private-files');

-- Atomic claim: only one account can start consuming a file at a time.
create or replace function public.claim_file_for_download(target_file_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare claimed_count integer;
begin
  update public.files
  set download_claimed_at = pg_catalog.now()
  where id = target_file_id
    and download_claimed_at is null;
  get diagnostics claimed_count = row_count;
  return claimed_count = 1;
end;
$$;

-- Release the claim if browser download retrieval fails.
create or replace function public.release_file_claim(target_file_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare released_count integer;
begin
  update public.files
  set download_claimed_at = null
  where id = target_file_id
    and download_claimed_at > pg_catalog.now() - interval '15 minutes';
  get diagnostics released_count = row_count;
  return released_count = 1;
end;
$$;

grant execute on function public.claim_file_for_download(uuid) to authenticated;
grant execute on function public.release_file_claim(uuid) to authenticated;
