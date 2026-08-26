// Admin-only: pulls real upcoming meetings from Calendly.
//
// Requires CALENDLY_API_TOKEN as a Supabase secret (Calendly -> Settings ->
// Integrations -> API & Webhooks -> Personal Access Token). Never shipped
// to the browser, only used here, server-side.
//
// Deploy: supabase functions deploy list-meetings
// Secret: supabase secrets set CALENDLY_API_TOKEN=...

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

    const token = Deno.env.get("CALENDLY_API_TOKEN");
    if (!token) {
      return json({ meetings: [], error: "Calendly isn't connected yet (missing CALENDLY_API_TOKEN)." }, 200);
    }

    const meRes = await fetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) {
      console.error("calendly /users/me error", meRes.status, await meRes.text());
      return json({ meetings: [], error: "Could not authenticate with Calendly. The token may be wrong or expired." }, 200);
    }
    const me = await meRes.json();
    const orgUri = me?.resource?.current_organization;
    if (!orgUri) {
      return json({ meetings: [], error: "Could not determine the Calendly organization." }, 200);
    }

    const nowIso = new Date().toISOString();
    const eventsUrl = "https://api.calendly.com/scheduled_events"
      + `?organization=${encodeURIComponent(orgUri)}`
      + `&min_start_time=${encodeURIComponent(nowIso)}`
      + "&status=active&sort=start_time:asc&count=25";

    const eventsRes = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!eventsRes.ok) {
      console.error("calendly scheduled_events error", eventsRes.status, await eventsRes.text());
      return json({ meetings: [], error: "Could not load meetings from Calendly." }, 200);
    }
    const eventsData = await eventsRes.json();
    const events = eventsData?.collection ?? [];

    const meetings = await Promise.all(events.map(async (ev: any) => {
      let invitees: { name: string; email: string }[] = [];
      try {
        const uuid = String(ev.uri).split("/").pop();
        const invRes = await fetch(`https://api.calendly.com/scheduled_events/${uuid}/invitees`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (invRes.ok) {
          const invData = await invRes.json();
          invitees = (invData?.collection ?? []).map((i: any) => ({ name: i.name, email: i.email }));
        }
      } catch (err) {
        console.error("calendly invitees fetch error", err);
      }
      return {
        name: ev.name,
        start_time: ev.start_time,
        end_time: ev.end_time,
        location: ev.location?.location ?? ev.location?.type ?? null,
        invitees,
      };
    }));

    return json({ meetings }, 200);
  } catch (err) {
    console.error("list-meetings error:", err);
    return json({ error: "Server error." }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
