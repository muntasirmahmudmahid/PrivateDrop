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
