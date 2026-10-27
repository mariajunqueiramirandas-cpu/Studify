-- Creating a Turma failed for everyone: private.new_invite_code() called public.gen_random_bytes(),
-- but on Supabase pgcrypto is preinstalled in the extensions schema, so the foundation's
-- `create extension if not exists pgcrypto` never put it in public. The random bytes now come from
-- pg_catalog.gen_random_uuid() (built in, pg_strong_random), which does not depend on that schema.
-- A v4 UUID fixes the version nibble (byte 7) and variant bits (byte 9); bytes 1-6 and 11-16 are
-- fully random. Rejection sampling keeps the distribution uniform (248 = 8 * 31).
create or replace function private.new_invite_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_out  text := '';
  v_pool bytea := ''::bytea;
  v_uuid bytea;
  v_byte int;
begin
  while char_length(v_out) < 8 loop
    if length(v_pool) = 0 then
      v_uuid := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
      v_pool := substring(v_uuid from 1 for 6) || substring(v_uuid from 11 for 6);
    end if;
    v_byte := get_byte(v_pool, 0);
    v_pool := substring(v_pool from 2);
    if v_byte < 248 then
      v_out := v_out || substr(v_alphabet, 1 + (v_byte % 31), 1);
    end if;
  end loop;
  return v_out;
end $$;
