-- chunk_counts(): per-source row counts for the /ops RAG tab's index
-- panel. A SQL aggregate RPC so the dashboard never fetches the whole
-- chunks table just to count rows (PostgREST has no GROUP BY).
--
-- STABLE: pure read, no side effects. service_role is how the server
-- authenticates under the sb_secret_* key (see 0002_chunks_grants.sql);
-- grant execute explicitly since function grants don't auto-apply either.

create or replace function public.chunk_counts()
returns table (source text, chunks bigint)
language sql
stable
as $$
  select source::text, count(*)::bigint as chunks
  from public.chunks
  group by source
  order by source;
$$;

grant execute on function public.chunk_counts() to service_role;
