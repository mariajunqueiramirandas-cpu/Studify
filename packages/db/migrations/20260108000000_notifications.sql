-- Rich notifications (PLT-05, api.md §9.1): the in-app Central de notificações.
-- Every notification the server sends (or could not send: no device token yet, channel turned off, daily
-- cap, quiet hours) also lands here with its rich payload, so the student can always find it in the app.
-- Live progress updates are not kept: they are transient by nature and end in a final notification that is.
--
-- Decisions (recorded in data-model.md R34):
--   * One row per notification key and user: a newer notification with the same key (the same duel, the
--     same material) replaces the older one and becomes unread again, like the system tray does.
--   * The worker writes rows with the service role; the student reads them, marks them read and deletes them.
--   * notification_log keeps its role (delivery decisions without message text); the inbox holds the text
--     and the payload because the student sees them anyway.
--   * Rows older than 60 days are purged by storage.purge.

create table public.notification_inbox (                     -- [svc] PLT-05
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  key         text not null check (char_length(key) between 1 and 80),
  type        text not null check (char_length(type) between 1 and 60),
  channel     text not null check (channel in ('reviews','plan','class','processing')),
  title       text not null check (char_length(title) between 1 and 80),
  body        text not null check (char_length(body) <= 240),
  deep_link   text check (deep_link ~ '^studify://'),
  rich        jsonb not null check (jsonb_typeof(rich) = 'object' and pg_column_size(rich) <= 8192),
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, key)
);
create index notification_inbox_user_time on public.notification_inbox (user_id, created_at desc);
create index notification_inbox_unread on public.notification_inbox (user_id) where read_at is null;

create trigger notification_inbox_set_updated_at before update on public.notification_inbox
  for each row execute function private.set_updated_at();

alter table public.notification_inbox enable row level security;
revoke all on public.notification_inbox from anon, authenticated;
grant select, delete on public.notification_inbox to authenticated;
grant update (read_at) on public.notification_inbox to authenticated;
create policy notification_inbox_select_own on public.notification_inbox for select to authenticated
  using (user_id = auth.uid());
create policy notification_inbox_update_own on public.notification_inbox for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notification_inbox_delete_own on public.notification_inbox for delete to authenticated
  using (user_id = auth.uid());

-- The bell badge updates live while the app is open.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notification_inbox;
  end if;
end $$;
