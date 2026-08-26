-- Lets the portal's email-first login step ask "is this email allowed to
-- have a portal account?" (client or admin) without ever exposing the
-- allowed_clients/admin_emails tables themselves. Returns only a boolean,
-- never any row data, so it can't be used to dump either list, only to
-- test one guess at a time (the same tradeoff any "is this email
-- registered" check makes).

create function public.is_allowed_client(check_email text)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.allowed_clients where lower(email) = lower(check_email)
  ) or exists (
    select 1 from public.admin_emails where lower(email) = lower(check_email)
  );
$$;

grant execute on function public.is_allowed_client(text) to anon, authenticated;
