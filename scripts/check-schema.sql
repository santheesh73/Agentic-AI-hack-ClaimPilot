-- Checks the live database against what supabase/migrations/0001-0004 create.
-- Read-only. Run it in the Supabase SQL editor (or any psql session).
-- Returns one row per problem; an EMPTY result means the live schema matches.
-- If you add a migration, add what it creates to the lists below.

with expected_columns(table_name, column_name, data_type) as (values
  ('cases','id','uuid'), ('cases','owner_id','text'), ('cases','title','text'),
  ('cases','insurer','text'), ('cases','claim_amount_inr','numeric'), ('cases','state','text'),
  ('cases','verdict','text'), ('cases','facts','jsonb'), ('cases','queries','jsonb'),
  ('cases','candidate_page_ids','ARRAY'), ('cases','rubric','jsonb'), ('cases','missing_facts','jsonb'),
  ('cases','answers','jsonb'), ('cases','route','jsonb'), ('cases','deadlines','jsonb'),
  ('cases','redraft_count','integer'), ('cases','redteam_done','boolean'),
  ('cases','dont_appeal_reason','text'), ('cases','complaint_sent_on','date'),
  ('cases','sim_offset_days','integer'), ('cases','error','text'),
  ('cases','created_at','timestamp with time zone'), ('cases','updated_at','timestamp with time zone'),
  ('cases','step_lock_until','timestamp with time zone'),                 -- 0003
  ('documents','id','uuid'), ('documents','case_id','uuid'), ('documents','kind','text'),
  ('documents','storage_path','text'), ('documents','filename','text'), ('documents','page_count','integer'),
  ('documents','created_at','timestamp with time zone'),
  ('pages','id','uuid'), ('pages','document_id','uuid'), ('pages','case_id','uuid'),
  ('pages','page_no','integer'), ('pages','text','text'), ('pages','text_norm','text'), ('pages','tsv','tsvector'),
  ('evidence','id','uuid'), ('evidence','case_id','uuid'), ('evidence','short_id','text'),
  ('evidence','claim','text'), ('evidence','page_id','uuid'), ('evidence','quote','text'),
  ('evidence','match_score','real'), ('evidence','verified','boolean'), ('evidence','source','text'),
  ('agent_events','id','bigint'), ('agent_events','case_id','uuid'), ('agent_events','step','text'),
  ('agent_events','tool','text'), ('agent_events','model','text'), ('agent_events','summary','text'),
  ('agent_events','input','jsonb'), ('agent_events','output','jsonb'), ('agent_events','tokens_in','integer'),
  ('agent_events','tokens_out','integer'), ('agent_events','ms','integer'),
  ('agent_events','created_at','timestamp with time zone'),
  ('agent_events','provider','text'),                                     -- 0002
  ('drafts','id','uuid'), ('drafts','case_id','uuid'), ('drafts','version','integer'),
  ('drafts','route_step','text'), ('drafts','body_md','text'), ('drafts','verification','jsonb'),
  ('drafts','redteam','jsonb'), ('drafts','verified_at','timestamp with time zone'),
  ('drafts','approved_at','timestamp with time zone'), ('drafts','created_at','timestamp with time zone'),
  ('followups','id','uuid'), ('followups','case_id','uuid'), ('followups','due_on','date'),
  ('followups','action','text'), ('followups','status','text'), ('followups','output_md','text'),
  ('followups','created_at','timestamp with time zone'),
  ('regulations','id','text'), ('regulations','step','text'), ('regulations','condition','text'),
  ('regulations','clock_days','integer'), ('regulations','source_url','text'), ('regulations','as_of','date'),
  ('rate_limits','owner_id','text'), ('rate_limits','bucket','text'),     -- 0004
  ('rate_limits','window_start','timestamp with time zone'), ('rate_limits','count','integer')
),
expected_tables as (select distinct table_name from expected_columns),
expected_functions(fn) as (values ('search_pages'), ('bump_rate_limit')),
expected_indexes(idx) as (values ('pages_tsv_idx'), ('pages_case_idx'), ('agent_events_case_idx')),
live_columns as (
  select table_name::text, column_name::text, data_type::text
  from information_schema.columns where table_schema = 'public'
)
select 'missing column' as problem, e.table_name || '.' || e.column_name as object, e.data_type as expected, null as actual
from expected_columns e
left join live_columns l using (table_name, column_name)
where l.column_name is null
union all
select 'wrong type', e.table_name || '.' || e.column_name, e.data_type, l.data_type
from expected_columns e join live_columns l using (table_name, column_name)
where l.data_type <> e.data_type
union all
select 'unexpected column', l.table_name || '.' || l.column_name, null, l.data_type
from live_columns l
join expected_tables t using (table_name)
left join expected_columns e using (table_name, column_name)
where e.column_name is null
union all
select 'RLS disabled', t.table_name, 'rowsecurity = true', 'false'
from expected_tables t join pg_tables p on p.schemaname = 'public' and p.tablename = t.table_name
where not p.rowsecurity
union all
select 'missing function', f.fn, 'present', null
from expected_functions f
where not exists (
  select 1 from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public' and pr.proname = f.fn
)
union all
select 'missing index', i.idx, 'present', null
from expected_indexes i
where not exists (select 1 from pg_indexes x where x.schemaname = 'public' and x.indexname = i.idx)
union all
select 'regulations row count', 'regulations', '5', count(*)::text
from regulations having count(*) <> 5
order by 1, 2;
