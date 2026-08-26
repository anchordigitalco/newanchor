-- Anchor Digital client portal: core schema.
-- One row of real data per logged-in client, everything gated by Row Level
-- Security so a client can only ever read their own rows. Clients get
-- read-only access here, Adam/Jackson manage the actual data via the
-- Supabase table editor (or a future internal tool), not through this site.

-- ---- profiles: one row per client, mirrors auth.users ----
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "clients can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- auto-create a profile row whenever a new auth user is added (Adam/Jackson
-- add users via Authentication -> Users in the Supabase dashboard)
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, company_name)
  values (new.id, new.raw_user_meta_data ->> 'company_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---- projects: the stat-card data on the dashboard ----
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  status text,
  next_milestone text,
  open_items int,
  last_update_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;

create policy "clients can view their own projects"
  on public.projects for select
  using (auth.uid() = client_id);

-- ---- activity: the activity feed panel ----
create table public.activity (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.activity enable row level security;

create policy "clients can view their own activity"
  on public.activity for select
  using (auth.uid() = client_id);

create index activity_client_id_created_at_idx
  on public.activity (client_id, created_at desc);

-- ---- storage: the "Drive" file drop, one private folder per client ----
insert into storage.buckets (id, name, public)
values ('client-files', 'client-files', false)
on conflict (id) do nothing;

create policy "clients can upload to their own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'client-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "clients can view their own files"
  on storage.objects for select
  using (
    bucket_id = 'client-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "clients can delete their own files"
  on storage.objects for delete
  using (
    bucket_id = 'client-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
