-- Supports a lease-based lock on /step so a double-click or two open tabs
-- can never execute the same state transition twice concurrently.
alter table cases add column if not exists step_lock_until timestamptz;
