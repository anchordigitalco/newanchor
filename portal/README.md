# Client portal

Every page a client or admin actually visits, from login through everything
behind it. All URLs are unchanged - `vercel.json` rewrites each clean URL
below to its file in this folder, so nothing that links to `/portal`,
`/dashboard`, etc. (email templates, `redirectTo` values, bookmarks) needed
to change.

## Pages (this folder)

| URL | File | What it is |
|---|---|---|
| `/portal` | `portal.html` | Login (email + password) |
| `/forgot-password` | `forgot-password.html` | Request a password-reset email |
| `/reset-password` | `reset-password.html` | Set a new password (reset-link landing) |
| `/create-password` | `create-password.html` | Set a password (invite-link landing) |
| `/email-changed` | `email-changed.html` | Confirms an email-change link |
| `/dashboard` | `dashboard.html` | Client portal (project status, Drive, Messages, Account, Schedule) |
| `/admin` | `admin.html` | Admin panel (clients, messages, meetings, files) |

## Supabase Edge Functions (`supabase/functions/`, not moved)

Have to stay where they are - `supabase functions deploy <name>` requires
each one directly under `supabase/functions/`, not nested. Listed here so
they're still findable as part of "the portal," not actually relocated:

- `portal-auth` - login/signup, called from `portal.html`
- `invite-client` - sends the real Supabase invite email, called from `admin.html`
- `list-client-status` - Active/Invited badge data, called from `admin.html`
- `delete-client` - full account deletion, called from `admin.html`
- `notify-client-update` - emails a client when an admin posts an activity update
- `studio-assistant` - the AI chat widget on `dashboard.html` (needs `ANTHROPIC_API_KEY`)
- `list-meetings` - pulls Calendly meetings for `admin.html` (needs `CALENDLY_API_TOKEN`)

`submit-contact-form` is the *main site's* contact form (index.html), not
part of the portal - deliberately left off this list.

## Database (`supabase/migrations/`, not moved)

Same reason as the functions - migrations have to stay flat under
`supabase/migrations/` for `supabase db push` to find and order them. All of
them are portal/admin schema:

- `20260826000000_init.sql` - profiles, projects, activity, Drive storage bucket
- `20260826000001_allowlist.sql` - `allowed_clients`
- `20260826000002_admin.sql` - `admin_emails`, `admins`, `is_admin()`
- `20260826000003_allowlist_check.sql` - blocks signup for non-allowlisted emails
- `20260826000004_messages.sql` - AI assistant transcript log
- `20260826000006_company_name_from_allowlist.sql` - profile company-name fallback
- `20260827000000_client_messages.sql` - direct client <-> admin messaging

(`20260826000005_contact_form.sql` is the main site's contact form table, not
part of the portal.)

## Assets

No portal-exclusive assets folder - the few images these pages use
(`favicon.png`, `anchor-icon.png`, `pillars/innovation.jpg`) are shared with
the main site, so they stay in the top-level `assets/` and are referenced
here by absolute path (`/assets/...`) rather than duplicated.

## Auth email templates (Supabase dashboard, not code)

The 11 Supabase Auth email templates (Invite, Reset Password, Confirm
Sign-Up, etc.) aren't files in this repo - they're pasted directly into the
Supabase dashboard (Authentication -> Email Templates). Not moved because
there's nothing here to move; noted so "everything" includes this too.
