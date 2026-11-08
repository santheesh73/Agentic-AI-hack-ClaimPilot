-- Fixed-window, per-owner rate limiting with no new services: one row per
-- (owner, bucket, window), incremented atomically by bump_rate_limit().
create table if not exists rate_limits (
  owner_id text not null,
  bucket text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (owner_id, bucket, window_start)
);

alter table rate_limits enable row level security;

-- Increments the counter for this window and returns true if the request is
-- still within the limit. Atomic via ON CONFLICT, so two concurrent requests
-- can't both read the same count and both slip under the limit.
create or replace function bump_rate_limit(p_owner text, p_bucket text, p_window_start timestamptz, p_limit int)
returns boolean
language sql
as $$
  insert into rate_limits (owner_id, bucket, window_start, count)
  values (p_owner, p_bucket, p_window_start, 1)
  on conflict (owner_id, bucket, window_start)
  do update set count = rate_limits.count + 1
  returning count <= p_limit;
$$;
