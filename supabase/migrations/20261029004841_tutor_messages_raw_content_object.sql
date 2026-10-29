-- User tutor rows store { body, slices, system_notes } in raw_content; assistant rows store content blocks (array).
alter table public.tutor_messages drop constraint tutor_messages_raw_content_check;
alter table public.tutor_messages add constraint tutor_messages_raw_content_check check (raw_content is null or jsonb_typeof(raw_content) in ('array', 'object'));
