-- AEROFORM cloud models. Run once in the Supabase dashboard: SQL Editor -> New query -> Run.
-- Creates a public bucket the app can list, download from and upload to with the publishable key.
-- Anyone who has the app (and therefore the key) can upload and list files. No delete or overwrite
-- policy is granted; remove files from the dashboard (Storage -> aeroform-models).

insert into storage.buckets (id, name, public, file_size_limit)
values ('aeroform-models', 'aeroform-models', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "aeroform models read" on storage.objects;
create policy "aeroform models read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'aeroform-models');

drop policy if exists "aeroform models upload" on storage.objects;
create policy "aeroform models upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'aeroform-models');
