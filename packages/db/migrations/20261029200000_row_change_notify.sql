-- Row changes for the app's live screens (ADR 0012, api.md §8). On Supabase these tables were in the
-- supabase_realtime publication; Studify's own API now streams them over its WebSocket (apps/api/src/realtime).
-- Each insert, update or delete sends one notification on the channel studify_row_changes with the table, the
-- operation and the keys a subscription can filter on. The API listens, re-reads the row as each subscriber (so
-- row level security still decides who sees it) and pushes it to the sockets that asked for it.
-- The payload carries keys only, never row data, so it stays far below NOTIFY's 8000-byte limit.

create or replace function private.notify_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  perform pg_catalog.pg_notify('studify_row_changes', jsonb_build_object(
    'table', tg_table_name,
    'op', tg_op,
    'id', v_row -> 'id',
    'user_id', v_row -> 'user_id',
    'subject_id', v_row -> 'subject_id',
    'class_group_id', v_row -> 'class_group_id')::text);
  return null;
end $$;

revoke all on function private.notify_row_change() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['ai_jobs', 'documents', 'class_group_members', 'notes', 'essays', 'duels',
                                 'camera_captures', 'podcast_episodes', 'notification_inbox']
  loop
    execute format('drop trigger if exists notify_row_change on public.%I', v_table);
    execute format('create trigger notify_row_change after insert or update or delete on public.%I
                    for each row execute function private.notify_row_change()', v_table);
  end loop;
end $$;
