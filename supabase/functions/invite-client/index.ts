// Admin-only: sends a client the real Supabase "Invite user" email as soon as they're added to
// the client list, instead of leaving it to them to find the portal and self-signup.
//
// inviteUserByEmail is a service-role-only API (creates the auth.users row directly and sends
// Supabase's own Invite template) - it can't be called from admin.html with the anon key, hence
// this function. Company name is passed through as signup metadata so handle_new_user() picks it
// up the same way a self-signup with metadata would (see the allowed_clients-fallback migration
// for the case where it isn't provided here).
//
// Deploy: supabase functions deploy invite-client --no-verify-jwt
// (verifies the caller's JWT itself, same is_admin pattern as list-meetings - --no-verify-jwt
// only skips Supabase's platform-level check so the function can return a clean 401 instead of a
// generic gateway error when there's no token at all)

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

    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
    const redirectTo = typeof body.redirectTo === "string" ? body.redirectTo : undefined;

    if (!email) {
      return json({ error: "Email is required." }, 400);
    }

    const { error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: companyName ? { company_name: companyName } : undefined,
      redirectTo,
    });

    if (inviteError) {
      // "already been registered" is the one case worth telling the admin about specifically -
      // everything else collapses to one honest, generic message rather than leaking driver detail.
      const msg = /already.*registered|already.*exists/i.test(inviteError.message || "")
        ? "That email already has an account - no invite sent."
        : "Could not send the invite.";
      console.error("invite-client error:", inviteError);
      return json({ error: msg }, 200);
    }

    return json({ ok: true }, 200);
  } catch (err) {
    console.error("invite-client error:", err);
    return json({ error: "Server error." }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
