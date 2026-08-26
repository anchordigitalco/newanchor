-- Anchor Digital client portal: self-serve signup, gated by an allowlist.
--
-- Adam/Jackson add a row here (Supabase Table Editor -> allowed_clients)
-- for every real client before telling them to sign up. Only an email
-- that appears in this table can ever create a portal account, enforced
-- by a database trigger on auth.users, not by anything the browser sends,
-- so it can't be bypassed by editing the page's JS.
--
-- IMPORTANT: this alone isn't enough. In Authentication -> Providers ->
-- Email, "Confirm email" must be turned ON. Without it, someone could type
-- in a real client's allowlisted email address without actually owning
-- that inbox and land straight in that client's portal. Confirmation ties
-- the new account to actually receiving mail at that address.

create table public.allowed_clients (
  email text primary key,
  company_name text,
  added_at timestamptz not null default now()
);

alter table public.allowed_clients enable row level security;
-- deliberately no policies: the API (anon/authenticated roles) gets zero
-- access to this table from the site. Only the security definer trigger
-- below (running as the table owner) can read it, and only Adam/Jackson
-- via the Supabase dashboard (which uses elevated access) can edit it.

create function public.check_client_allowlist()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.allowed_clients where lower(email) = lower(new.email)
  ) then
    raise exception 'not_allowlisted';
  end if;
  return new;
end;
$$;

create trigger enforce_client_allowlist
  before insert on auth.users
  for each row execute procedure public.check_client_allowlist();
