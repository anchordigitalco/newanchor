-- Studio assistant conversation log, so admins can read what clients have
-- actually been asking. Written by the studio-assistant Edge Function
-- (service role), never directly by the browser, there's deliberately no
-- insert policy here for clients or admins.

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

create policy "clients can view their own messages"
  on public.messages for select
  using (auth.uid() = client_id);

create policy "admins can view all messages"
  on public.messages for select
  using (public.is_admin(auth.uid()));

create index messages_client_id_created_at_idx
  on public.messages (client_id, created_at desc);
