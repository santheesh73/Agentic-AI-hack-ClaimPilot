-- ClaimPilot audit: read-only schema & security checks.
-- Run against a TEST/STAGING project (never needed on production):
--   psql "$TEST_DATABASE_URL" -f audit/check-schema.sql
-- or paste into the Supabase SQL editor. Every query only reads catalogs.

-- 1. RLS enabled on every public table (expect rls = true for all 9)
select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;

-- 2. Any RLS policies at all? (design: none -> anon/authenticated get 0 rows)
select schemaname, tablename, policyname, roles, cmd, qual from pg_policies where schemaname = 'public';

-- 3. Table privileges granted to anon / authenticated (Supabase grants these by default;
--    with RLS on and no policies they still return 0 rows, but note them)
select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
group by 1, 2 order by 1, 2;

-- 4. Functions: security definer? search_path pinned? executable by anon?
select p.proname, p.prosecdef as security_definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('search_pages', 'bump_rate_limit');

-- 5. Storage bucket privacy (bucket is not created by any migration in the repo)
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;
select policyname, cmd, roles, qual from pg_policies where schemaname = 'storage' and tablename = 'objects';

-- 6. Constraints the app relies on
select conrelid::regclass as table, conname, pg_get_constraintdef(oid) as def
from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2;

-- 7. Indexes used by search_pages and the trace queries
select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2;

-- 8. Generated tsv column
select column_name, is_generated, generation_expression from information_schema.columns
where table_schema = 'public' and table_name = 'pages' and column_name = 'tsv';

-- 9. Seed data present
select id, step, clock_days, source_url, as_of from regulations order by id;

-- 10. Query plans (needs at least one case with pages; replace the uuid)
-- explain analyze select * from search_pages('<case-uuid>', 'pre-existing disease waiting period', 6);
-- explain analyze select * from agent_events where case_id = '<case-uuid>' order by id;

-- 11. Anon-key probe (run from a shell, NOT in SQL). Every call must return [] or an error:
--   for t in cases documents pages evidence agent_events drafts followups regulations rate_limits; do
--     curl -s "$SUPABASE_URL/rest/v1/$t?select=*&limit=1" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"; echo " <- $t"; done
--   curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/search_pages" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--     -H 'content-type: application/json' -d '{"p_case":"00000000-0000-0000-0000-000000000000","p_query":"disease"}'
--   curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/bump_rate_limit" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--     -H 'content-type: application/json' -d '{"p_owner":"x","p_bucket":"step","p_window_start":"2026-01-01T00:00:00Z","p_limit":1}'
