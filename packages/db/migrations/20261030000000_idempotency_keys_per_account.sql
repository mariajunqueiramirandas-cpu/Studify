-- The API keeps one private.idempotency_keys row per write call (api.md §2.4), before the call runs. The row pointed
-- at public.profiles, so any write from a signed-in student who has no profile yet (sign-up not finished, or a fresh
-- database after ADR 0012) failed with a foreign-key error and a 500 instead of the call's own answer. It now
-- points at the account (auth.users, which the API writes on the first verified token). Deleting the account still
-- removes the rows; rows are also purged nightly after 24 hours (storage.purge).
alter table private.idempotency_keys drop constraint if exists idempotency_keys_user_id_fkey;
alter table private.idempotency_keys
  add constraint idempotency_keys_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
