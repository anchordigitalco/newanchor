-- The dashboard greeting ("Hello, {company}") reads profiles.company_name,
-- which handle_new_user() only ever populated from raw_user_meta_data - but
-- nothing in the signup flow (portal.html -> portal-auth Edge Function ->
-- supabase.auth.signUp) ever sends that metadata. The company name an admin
-- actually types in when adding someone to allowed_clients lives only on
-- that table, and was never being carried over to the client's own profile
-- once they signed up, so the greeting silently fell back to the generic
-- heading for every real client.
--
-- Fix at the source: have handle_new_user() fall back to the matching
-- allowed_clients.company_name (that's the one place an admin actually
-- enters it today) whenever the signup metadata doesn't carry one.
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
    values (
      new.id,
      new.email,
      coalesce(
        new.raw_user_meta_data ->> 'company_name',
        (select company_name from public.allowed_clients where lower(email) = lower(new.email))
      )
    );
  end if;
  return new;
end;
$$;

-- backfill: anyone who already signed up before this fix has a profile
-- stuck with a null company_name even though it's sitting right there on
-- allowed_clients. one-time catch-up so existing accounts get the greeting
-- immediately too, not just new signups from here on.
update public.profiles p
set company_name = a.company_name
from public.allowed_clients a
where lower(p.email) = lower(a.email)
  and p.company_name is null
  and a.company_name is not null;
