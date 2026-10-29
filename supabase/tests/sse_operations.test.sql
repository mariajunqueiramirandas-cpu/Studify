begin;
select plan(5);
select has_column('public', 'ai_jobs', 'operation_id', 'progress records direct operation identity');
select ok((select relrowsecurity from pg_class where oid = 'private.scheduled_actions'::regclass), 'calendar entries have RLS enabled');
select is(has_table_privilege('anon', 'private.scheduled_actions', 'select'), false, 'anonymous clients cannot read scheduled payloads');
select is(has_table_privilege('authenticated', 'private.scheduled_actions', 'insert'), false, 'students cannot schedule privileged operations directly');
select is(has_table_privilege('service_role', 'private.scheduled_actions', 'select,insert,update,delete'), true, 'server role can manage its calendar');
select * from finish();
rollback;
