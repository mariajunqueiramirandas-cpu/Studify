-- Storage buckets and policies (data-model.md §7, security-privacy.md §5).
-- Guarded: on a plain Postgres without the Supabase storage schema this file does nothing.
-- Paths: the first segment is the authorization key (try_uuid() turns non-uuid segments into NULL,
-- which the helpers treat as "no access").

do $$
begin
  if to_regnamespace('storage') is null then
    raise notice 'storage schema not found: skipping buckets and storage policies';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
    ('documents',   'documents',   false, 104857600, array['application/pdf']),          -- 100 MB
    ('page-images', 'page-images', false, null,      array['image/webp','image/jpeg']),
    ('page-text',   'page-text',   false, null,      array['application/json']),
    ('slices',      'slices',      false, null,      array['application/pdf']),
    ('media',       'media',       false, null,      array['image/webp','image/jpeg','image/png']),
    ('photos',      'photos',      false, 15728640,  array['image/jpeg','image/png','image/webp','image/heic']), -- 15 MB
    ('audio',       'audio',       false, null,      array['audio/mpeg','audio/mp4']),
    ('enem',        'enem',        false, null,      array['image/webp']),
    ('avatars',     'avatars',     false, 1048576,   array['image/webp']),                -- 1 MB
    ('exports',     'exports',     false, null,      array['application/zip'])
  on conflict (id) do nothing;

  alter table storage.objects enable row level security;

  -- documents/{subject_id}/{document_id}.pdf
  create policy storage_documents_read on storage.objects for select to authenticated
    using (bucket_id = 'documents'
           and private.can_read_subject(private.try_uuid((storage.foldername(name))[1])));
  create policy storage_documents_upload on storage.objects for insert to authenticated
    with check (bucket_id = 'documents'
                and private.can_upload_to_subject(private.try_uuid((storage.foldername(name))[1])));

  -- photos/{user_id}/{document_id|capture_id}/{n}.jpg : owner only
  create policy storage_photos_owner on storage.objects for all to authenticated
    using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

  -- page-images/{document_id}/... and page-text/{document_id}/... : readers of the document's subject
  create policy storage_page_assets_read on storage.objects for select to authenticated
    using (bucket_id in ('page-images','page-text')
           and private.can_read_document(private.try_uuid((storage.foldername(name))[1])));

  -- media/{subject_id}/{kind}/{id}.webp : readers of the subject may read and add user image cards
  create policy storage_media_read on storage.objects for select to authenticated
    using (bucket_id = 'media' and private.can_read_subject(private.try_uuid((storage.foldername(name))[1])));
  create policy storage_media_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'media' and private.can_read_subject(private.try_uuid((storage.foldername(name))[1])));

  -- audio/{subject_id}/{episode_id}.mp3 (subject readers) and audio/answers/{user_id}/{id}.mp3 (owner)
  create policy storage_audio_read on storage.objects for select to authenticated
    using (bucket_id = 'audio'
           and (private.can_read_subject(private.try_uuid((storage.foldername(name))[1]))
                or ((storage.foldername(name))[1] = 'answers' and (storage.foldername(name))[2] = auth.uid()::text)));

  -- enem/{edition_year}/{co_item}/{n}.webp : any signed-in user (public reference data, Phase 4)
  create policy storage_enem_read on storage.objects for select to authenticated
    using (bucket_id = 'enem');

  -- avatars/{user_id}.webp : own write; readable by Turma co-members
  create policy storage_avatars_read on storage.objects for select to authenticated
    using (bucket_id = 'avatars'
           and (name = auth.uid()::text || '.webp'
                or private.shares_class_with(private.try_uuid(split_part(name, '.', 1)))));
  create policy storage_avatars_owner_write on storage.objects for all to authenticated
    using (bucket_id = 'avatars' and name = auth.uid()::text || '.webp')
    with check (bucket_id = 'avatars' and name = auth.uid()::text || '.webp');

  -- exports/{user_id}/{export_id}.zip : owner reads (signed URL); the worker writes with the service role
  create policy storage_exports_owner_read on storage.objects for select to authenticated
    using (bucket_id = 'exports' and (storage.foldername(name))[1] = auth.uid()::text);

  -- documents delete, slices, and every other write stay service-role only (no policy = no access).
end $$;
