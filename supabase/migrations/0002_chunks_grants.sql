-- M2.1.4b — service_role grants on chunks table.
--
-- When supabase-js authenticates with the new sb_secret_* key format,
-- it acts as the service_role Postgres role. Tables created via
-- migrations in the public schema do not auto-grant service_role
-- access under current Supabase defaults; explicit grants are
-- required. We apply them here as a tracked migration so a fresh
-- project bootstrap reaches the same state.

grant usage on schema public to service_role;
grant select, insert, update, delete on public.chunks to service_role;
