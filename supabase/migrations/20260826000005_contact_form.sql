-- Backs the public contact-form Edge Function's rate limit. Unlike an
-- in-memory counter (which resets on every cold start on serverless
-- hosting), this persists, so the limit actually holds across invocations.
-- No content is stored here, just enough to count recent attempts per IP.

create table public.contact_rate_limit (
  id bigint generated always as identity primary key,
  ip text not null,
  created_at timestamptz not null default now()
);

alter table public.contact_rate_limit enable row level security;
-- no policies: only the Edge Function (service role) touches this table

create index contact_rate_limit_ip_created_at_idx
  on public.contact_rate_limit (ip, created_at desc);
