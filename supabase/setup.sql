-- PrivateDrop backend setup for Supabase (per-user private data + invite-only registration)
-- Run this entire file in Supabase Dashboard > SQL Editor.
-- Each user can only see, download and delete THEIR OWN files.
create extension if not exists pgcrypto;

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  original_name text not null check (char_length(original_name) between 1 and 2048),
  size_bytes bigint not null check (size_bytes >= 0),
  storage_path text not null unique,
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  download_claimed_at timestamptz
);

alter table public.files enable row level security;

-- Table policies: only the owner of a row can see / add / delete it.
drop policy if exists "Authenticated users can list shared files" on public.files;
drop policy if exists "Users can list own files" on public.files;
create policy "Users can list own files"
on public.files for select to authenticated
using (uploaded_by = (select auth.uid()));

drop policy if exists "Authenticated users can upload metadata" on public.files;
drop policy if exists "Users can add own files" on public.files;
create policy "Users can add own files"
on public.files for insert to authenticated
with check (uploaded_by = (select auth.uid()));

drop policy if exists "Authenticated users can delete metadata" on public.files;
drop policy if exists "Users can delete own files" on public.files;
create policy "Users can delete own files"
on public.files for delete to authenticated
using (uploaded_by = (select auth.uid()));

revoke update on public.files from anon, authenticated;
grant select, insert, delete on public.files to authenticated;
grant usage on schema public to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-files', 'private-files', false, 52428800, null)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- Storage policies: every user can only touch objects inside their own folder
-- (the first folder name must be the user's id).
drop policy if exists "Signed-in users can upload private files" on storage.objects;
drop policy if exists "Users upload to own folder" on storage.objects;
create policy "Users upload to own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'private-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Signed-in users can download private files" on storage.objects;
drop policy if exists "Users read own folder" on storage.objects;
create policy "Users read own folder"
on storage.objects for select to authenticated
using (bucket_id = 'private-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Signed-in users can delete private files" on storage.objects;
drop policy if exists "Users delete own folder" on storage.objects;
create policy "Users delete own folder"
on storage.objects for delete to authenticated
using (bucket_id = 'private-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Old claim functions are no longer used.
drop function if exists public.claim_file_for_download(uuid);
drop function if exists public.release_file_claim(uuid);

-- Names are now stored encrypted (longer text), so widen the old length limit.
alter table public.files drop constraint if exists files_original_name_check;
alter table public.files add constraint files_original_name_check
  check (char_length(original_name) between 1 and 2048);

-- =====================================================================
-- Invite-only registration
-- =====================================================================
-- Settings table: invite code + maximum number of users.
-- RLS is on and no policy exists, so nobody can read it through the API.
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  invite_code text not null,
  max_users integer not null default 5 check (max_users > 0)
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

-- !!! CHANGE the code below to your own long random text, then run the file. !!!
-- (Re-running this file never overwrites an existing code.)
insert into public.app_settings (id, invite_code, max_users)
values (true, '018c8b25-50ce-45f9-98d4-5273f8aba000', 5)
on conflict (id) do nothing;

-- Runs before every new account is created. Rejects it if the invite code is
-- wrong or the user limit is reached.
create or replace function public.enforce_invite_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  user_count integer;
begin
  perform pg_advisory_xact_lock(727301); -- two sign-ups at once cannot both pass
  select * into s from public.app_settings where id;
  if not found or left(s.invite_code, 11) = 'CHANGE_THIS' then
    raise exception 'registration_closed';
  end if;
  if coalesce(new.raw_user_meta_data ->> 'invite_code', '') <> s.invite_code then
    raise exception 'invalid_invite';
  end if;
  select count(*) into user_count from auth.users;
  if user_count >= s.max_users then
    raise exception 'user_limit_reached';
  end if;
  new.raw_user_meta_data := new.raw_user_meta_data - 'invite_code';
  return new;
end;
$$;
revoke execute on function public.enforce_invite_signup() from public, anon, authenticated;

drop trigger if exists enforce_invite_signup on auth.users;
create trigger enforce_invite_signup
before insert on auth.users
for each row execute function public.enforce_invite_signup();

-- =====================================================================
-- Folders + file metadata (migration 002) and private folders (migration 003)
-- =====================================================================
-- PrivateDrop migration 002: nested folders + richer file metadata.
-- Safe to run on an existing database (idempotent). Run in Supabase Dashboard > SQL Editor.

-- 1) Folders (parent_id = null means root)
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 255 and name !~ '[/\\]'),
  parent_id uuid references public.folders(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique folder name per parent (case-insensitive; root folders share one "null parent" bucket)
create unique index if not exists folders_unique_name_per_parent
  on public.folders (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index if not exists folders_parent_created_idx
  on public.folders (parent_id, created_at desc);

-- 2) Extra file metadata + folder link
alter table public.files
  add column if not exists folder_id uuid references public.folders(id) on delete cascade,
  add column if not exists mime_type text,
  add column if not exists extension text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists files_folder_created_idx
  on public.files (folder_id, created_at desc);

-- Backfill extension for files uploaded before this migration
update public.files
set extension = lower(substring(original_name from '\.([A-Za-z0-9]{1,10})$'))
where extension is null;

-- 3) updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists files_touch_updated_at on public.files;
create trigger files_touch_updated_at before update on public.files
for each row execute function public.touch_updated_at();

drop trigger if exists folders_touch_updated_at on public.folders;
create trigger folders_touch_updated_at before update on public.folders
for each row execute function public.touch_updated_at();

-- 4) Row Level Security for folders (same shared-inbox model as files)
alter table public.folders enable row level security;

drop policy if exists "Authenticated users can list folders" on public.folders;
create policy "Authenticated users can list folders"
on public.folders for select to authenticated using (true);

drop policy if exists "Authenticated users can create folders" on public.folders;
create policy "Authenticated users can create folders"
on public.folders for insert to authenticated
with check (created_by = (select auth.uid()));

drop policy if exists "Authenticated users can delete folders" on public.folders;
create policy "Authenticated users can delete folders"
on public.folders for delete to authenticated using (true);

revoke all on public.folders from anon;
revoke update on public.folders from authenticated;
grant select, insert, delete on public.folders to authenticated;

-- 5) Lists every storage object inside a folder tree (used before deleting a folder,
--    because deleting DB rows does not delete Storage objects).
create or replace function public.folder_storage_paths(root_id uuid)
returns table(storage_path text)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive tree as (
    select id from public.folders where id = root_id
    union all
    select f.id from public.folders f join tree t on f.parent_id = t.id
  )
  select fi.storage_path
  from public.files fi
  where fi.folder_id in (select id from tree)
  order by fi.storage_path;
$$;

grant execute on function public.folder_storage_paths(uuid) to authenticated;

-- PrivateDrop migration 003: folders become PRIVATE per user (like files) and folder names can be encrypted.
-- Run AFTER migration_002_folders.sql. Safe to run more than once. Run in Supabase SQL Editor.

-- 1) Each user sees / creates / deletes only their own folders (migration 002 let every user see all folders).
drop policy if exists "Authenticated users can list folders" on public.folders;
drop policy if exists "Authenticated users can create folders" on public.folders;
drop policy if exists "Authenticated users can delete folders" on public.folders;
drop policy if exists "Users can list own folders" on public.folders;
drop policy if exists "Users can add own folders" on public.folders;
drop policy if exists "Users can delete own folders" on public.folders;

create policy "Users can list own folders"
on public.folders for select to authenticated
using (created_by = (select auth.uid()));

-- A new folder may only sit inside a folder the user can already see (their own).
create policy "Users can add own folders"
on public.folders for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (parent_id is null or exists (select 1 from public.folders p where p.id = parent_id))
);

create policy "Users can delete own folders"
on public.folders for delete to authenticated
using (created_by = (select auth.uid()));

-- 2) Folder names are stored encrypted (base64 text can contain "/"), so relax the old checks.
alter table public.folders drop constraint if exists folders_name_check;
alter table public.folders add constraint folders_name_check
  check (char_length(name) between 1 and 2048);
drop index if exists public.folders_unique_name_per_parent; -- cannot compare encrypted names in SQL

-- 3) A file may only be placed in one of the user's own folders.
drop policy if exists "Users can add own files" on public.files;
create policy "Users can add own files"
on public.files for insert to authenticated
with check (
  uploaded_by = (select auth.uid())
  and (folder_id is null or exists (select 1 from public.folders f where f.id = folder_id))
);

-- Note: files.mime_type and files.extension stay empty on purpose. The file type lives inside the
-- encrypted name/metadata, so the owner of the Supabase project cannot see what kind of files you store.
