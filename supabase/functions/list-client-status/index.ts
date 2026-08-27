// Admin-only: returns each auth user's email_confirmed_at / last_sign_in_at, so admin.html can
// tell an invited-but-not-yet-confirmed client apart from one who's actually finished setting up
// their account.
//
// Why this needs its own function: a profiles row now gets created the instant an admin invites
// someone (handle_new_user() fires on auth.users insert, and inviteUserByEmail() creates that row
// immediately - see invite-client) - well before the client has clicked the link or set a
// password. "Does a profiles row exist" used to mean "this client finished signing up" back when
// self-signup was the only path in, but it doesn't anymore. auth.users itself has the real
// signal (email_confirmed_at), but it isn't exposed to the browser at all (protected schema, no
// PostgREST access), hence this - same admin-JWT-check pattern as list-meetings/invite-client.
//
// Deploy: supabase functions deploy list-client-status --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return json({ error: "Please log in." }, 401);
    }

    const { data: isAdmin, error: isAdminError } = await supabaseAdmin.rpc("is_admin", {
      uid: userData.user.id,
    });
    if (isAdminError || !isAdmin) {
      return json({ error: "Admins only." }, 403);
    }

    // listUsers is paginated (1000/page) - looped so this stays correct as the client list grows
    // past one page, not just today's small one.
    const statuses: { email: string; confirmed: boolean; lastSignInAt: string | null }[] = [];
    let page = 1;
    while (true) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) {
        console.error("list-client-status listUsers error:", error);
        return json({ error: "Could not load user status." }, 200);
      }
      for (const u of data.users) {
        if (!u.email) continue;
        statuses.push({
          email: u.email,
          confirmed: !!u.email_confirmed_at,
          lastSignInAt: u.last_sign_in_at ?? null,
        });
      }
      if (data.users.length < 1000) break;
      page++;
    }

    return json({ statuses }, 200);
  } catch (err) {
    console.error("list-client-status error:", err);
    return json({ error: "Server error." }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
