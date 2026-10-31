create extension if not exists pgcrypto;

create table cases (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  title text,
  insurer text,
  claim_amount_inr numeric,
  state text not null default 'INTAKE',
  verdict text,                     -- STRONG | ARGUABLE | WEAK
  facts jsonb,                      -- extract_rejection output
  queries jsonb,
  candidate_page_ids uuid[] default '{}',
  rubric jsonb,                     -- six checks
  missing_facts jsonb,              -- [{key, question}]
  answers jsonb default '{}'::jsonb,
  route jsonb,                      -- {step, addressee, reason}
  deadlines jsonb,                  -- [{label, date, rule_id}]
  redraft_count int not null default 0,
  redteam_done boolean not null default false,
  dont_appeal_reason text,
  complaint_sent_on date,           -- set on approve (sim-aware)
  sim_offset_days int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  kind text not null check (kind in ('policy','rejection','discharge','other')),
  storage_path text,
  filename text,
  page_count int,
  created_at timestamptz not null default now()
);

create table pages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  page_no int not null,
  text text not null,
  text_norm text not null,
  tsv tsvector generated always as (to_tsvector('english', text)) stored
);
create index pages_tsv_idx on pages using gin (tsv);
create index pages_case_idx on pages (case_id);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  short_id text not null,           -- e.g. E1, E2 (used in [cite:E1])
  claim text not null,
  page_id uuid not null references pages(id) on delete cascade,
  quote text not null,
  match_score real,
  verified boolean not null default false,
  source text not null default 'assess', -- assess | redteam
  unique (case_id, short_id)
);

create table agent_events (
  id bigserial primary key,
  case_id uuid not null references cases(id) on delete cascade,
  step text not null,
  tool text,
  model text,
  summary text,                     -- one human-readable line for the trace UI
  input jsonb,
  output jsonb,
  tokens_in int, tokens_out int, ms int,
  created_at timestamptz not null default now()
);
create index agent_events_case_idx on agent_events (case_id, id);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  version int not null,
  route_step text,
  body_md text not null,
  verification jsonb,               -- [{short_id, ok, score}]
  redteam jsonb,                    -- red-team output this version answers / received
  verified_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table followups (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  due_on date not null,
  action text not null,             -- e.g. ESCALATE_BIMA_BHAROSA, OMBUDSMAN_ELIGIBLE, OMBUDSMAN_LAST_DATE
  status text not null default 'pending', -- pending | fired | done
  output_md text,                   -- generated escalation draft when fired
  created_at timestamptz not null default now()
);

create table regulations (
  id text primary key,
  step text not null,
  condition text not null,
  clock_days int,
  source_url text not null,
  as_of date not null
);

insert into regulations (id, step, condition, clock_days, source_url, as_of) values
('GRO_14D','insurer_gro','Written complaint to the insurer''s Grievance Redressal Officer first; insurer must resolve within 14 days.',14,'https://telanganatoday.com/policyholders-can-approach-irdai-for-unresolved-insurance-complaints','2026-10-31'),
('BIMA_BHAROSA','irdai_bima_bharosa','If no resolution or unsatisfactory reply, escalate to IRDAI Grievance Redressal Cell via the Bima Bharosa portal.',null,'https://telanganatoday.com/policyholders-can-approach-irdai-for-unresolved-insurance-complaints','2026-10-31'),
('OMB_ELIGIBLE','ombudsman','Ombudsman complaint lies if the insurer rejected the complaint, replied unsatisfactorily, or did not reply within one month.',30,'https://cioins.co.in/Faqs','2026-10-31'),
('OMB_1YEAR','ombudsman','File with the Ombudsman within one year of the rejection/reply, or of the expiry of the one-month no-reply period.',365,'https://cioins.co.in/Faqs','2026-10-31'),
('OMB_CAP','ombudsman','Relief sought must not exceed Rs 50 lakh; matter must not be pending before a court, consumer forum or arbitrator.',null,'https://blog.ipleaders.in/insurance-ombudsman-complaint-procedure-and-awards/','2026-10-31');

-- Full-text search over a case's pages
create or replace function search_pages(p_case uuid, p_query text, p_limit int default 6)
returns table (id uuid, page_no int, document_id uuid, rank real, text text)
language sql stable as $$
  select p.id, p.page_no, p.document_id, ts_rank_cd(p.tsv, websearch_to_tsquery('english', p_query)) as rank, p.text
  from pages p
  join documents d on d.id = p.document_id and d.kind = 'policy'
  where p.case_id = p_case and p.tsv @@ websearch_to_tsquery('english', p_query)
  order by rank desc
  limit p_limit;
$$;

alter table cases enable row level security;
alter table documents enable row level security;
alter table pages enable row level security;
alter table evidence enable row level security;
alter table agent_events enable row level security;
alter table drafts enable row level security;
alter table followups enable row level security;
alter table regulations enable row level security;
