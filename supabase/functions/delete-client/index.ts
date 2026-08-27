// Admin-only: fully deletes a client's account - not just their allowed_clients row.
//
// Deleting auth.users cascades through profiles -> projects/activity/messages (all "on delete
// cascade" FKs already in the schema - see the migrations), but their uploaded files in the
// client-files storage bucket are NOT covered by that cascade (storage.objects is keyed by
// folder path, not a real FK to profiles), so those are removed here first.
//
// After this, if they're invited again it's a brand new auth.users row with no password on it -
// the exact same "create your password" flow as a first-time invite, nothing carries over.
//
// Deploy: supabase functions deploy delete-client --no-verify-jwt

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
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) {
      return json({ error: "Email is required." }, 400);
    }

    // no getUserByEmail on the admin API - page through listUsers the same way
    // list-client-status does, and match on email.
    let target: { id: string } | null = null;
    let page = 1;
    while (!target) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) {
        console.error("delete-client listUsers error:", error);
        return json({ error: "Could not look up that account." }, 200);
      }
      target = data.users.find((u) => (u.email || "").toLowerCase() === email) ?? null;
      if (data.users.length < 1000) break;
      page++;
    }

    if (!target) {
      // no auth account exists yet (only ever on the allowlist, never invited or signed up) -
      // nothing to delete here, not an error.
      return json({ ok: true, hadAccount: false }, 200);
    }

    const { data: files, error: listFilesError } = await supabaseAdmin.storage
      .from("client-files")
      .list(target.id);
    if (listFilesError) {
      console.error("delete-client list files error:", listFilesError);
    } else if (files && files.length > 0) {
      const paths = files.map((f) => `${target!.id}/${f.name}`);
      const { error: removeFilesError } = await supabaseAdmin.storage.from("client-files").remove(paths);
      if (removeFilesError) console.error("delete-client remove files error:", removeFilesError);
    }

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(target.id);
    if (deleteError) {
      console.error("delete-client deleteUser error:", deleteError);
      return json({ error: "Could not delete that account." }, 200);
    }

    return json({ ok: true, hadAccount: true }, 200);
  } catch (err) {
    console.error("delete-client error:", err);
    return json({ error: "Server error." }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
