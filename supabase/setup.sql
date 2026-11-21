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
