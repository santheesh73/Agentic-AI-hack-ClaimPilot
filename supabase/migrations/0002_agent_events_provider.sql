-- Records which LLM provider (anthropic | google) produced each agent_events
-- row, now that the provider is configurable via LLM_PROVIDER (see lib/models.ts).
alter table agent_events add column if not exists provider text;
