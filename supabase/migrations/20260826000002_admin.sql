-- Admin accounts for Adam and Jackson: full visibility into every client's
-- profile, project, activity, and Drive files. Kept as its own allowlist
-- and its own permission table, entirely separate from allowed_clients, so
-- there's no path by which a client account ever ends up with admin access.
--
-- Setup, one-time, done by whoever has Supabase dashboard access (not
-- exposed anywhere in the site's UI):
--   insert into public.admin_emails (email) values ('adam@anchordigitalco.com'), ('jackson@anchordigitalco.com');
-- Then Adam and Jackson each create their account through the normal portal
-- login flow (email, then set a password), same as a client would. Because
-- their email is in admin_emails, the signup trigger lets it through, and
-- handle_new_user promotes them to admins automatically, no manual SQL
-- needed after that. The portal recognizes them and sends them to
-- admin.html instead of dashboard.html.

create table public.admin_emails (
  email text primary key,
  added_at timestamptz not null default now()
);
alter table public.admin_emails enable row level security;
-- no policies: fully closed to the API, dashboard/SQL-editor access only

create table public.admins (
  id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create function public.is_admin(uid uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (select 1 from public.admins where id = uid);
$$;
grant execute on function public.is_admin(uuid) to anon, authenticated;

create function public.am_i_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select public.is_admin(auth.uid());
$$;
grant execute on function public.am_i_admin() to authenticated;

create policy "admins can see the admin list"
  on public.admins for select
  using (public.is_admin(auth.uid()));

-- profiles needs the client's email on it so admins can identify who's who
-- without needing access to the protected auth.users table
alter table public.profiles add column email text;

-- signup now branches: an admin_emails match becomes an admin (no client
-- profile), everyone else (already gated by allowed_clients) becomes a
-- client profile as before, now with their email stored on it too.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (select 1 from public.admin_emails where lower(email) = lower(new.email)) then
    insert into public.admins (id) values (new.id) on conflict do nothing;
  else
    insert into public.profiles (id, email, company_name)
    values (new.id, new.email, new.raw_user_meta_data ->> 'company_name');
  end if;
  return new;
end;
$$;

-- the signup gate now accepts either list
create or replace function public.check_client_allowlist()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (select 1 from public.allowed_clients where lower(email) = lower(new.email))
     or exists (select 1 from public.admin_emails where lower(email) = lower(new.email)) then
    return new;
  end if;
  raise exception 'not_allowlisted';
end;
$$;

-- ---- admins can see and manage everything a client can only see their own of ----
create policy "admins can manage all profiles" on public.profiles
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create policy "admins can manage all projects" on public.projects
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create policy "admins can manage all activity" on public.activity
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create policy "admins can manage the client allowlist" on public.allowed_clients
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create policy "admins can manage all client files" on storage.objects
  for all using (bucket_id = 'client-files' and public.is_admin(auth.uid()))
  with check (bucket_id = 'client-files' and public.is_admin(auth.uid()));
