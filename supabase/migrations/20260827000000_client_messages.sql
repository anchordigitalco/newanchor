-- Direct two-way messaging between a client and the studio (admin.html's "Messages" view) -
-- a distinct feature from the AI studio assistant (public.messages, still used as-is by
-- studio-assistant for its own transcript log). Kept as a separate table on purpose rather than
-- reusing public.messages, since conflating "what a client asked the bot" with "what a client
-- said directly to Adam/Jackson" would make both harder to reason about.

create table public.client_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  sender text not null check (sender in ('client','admin')),
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.client_messages enable row level security;

create policy "clients can view their own messages"
  on public.client_messages for select
  using (auth.uid() = client_id);

-- clients can only ever insert as themselves, and only as sender='client' - the check here is
-- what actually stops a client from spoofing an admin reply, not anything in the app code.
create policy "clients can send their own messages"
  on public.client_messages for insert
  with check (auth.uid() = client_id and sender = 'client');

create policy "admins can manage all client messages"
  on public.client_messages for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create index client_messages_client_id_created_at_idx
  on public.client_messages (client_id, created_at desc);
