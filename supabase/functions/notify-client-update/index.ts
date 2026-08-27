// Admin-only: emails a client when an admin posts a project update (an activity insert), so they
// don't have to happen to check the dashboard to notice it. Same visual design system as the
// Supabase Auth email templates (hero photo header, dark pill button, logo footer) - sent
// independently of those since this isn't an auth event, and Supabase's own Custom SMTP config
// only covers its own auth emails, not anything an Edge Function sends.
//
// Requires the SAME Gmail App Password already set up for Supabase Auth's Custom SMTP
// (Authentication -> Emails -> SMTP Settings in the dashboard), stored again here as its own
// secret since Edge Functions can't read Supabase's own SMTP config.
// Secret: supabase secrets set GMAIL_APP_PASSWORD=... (no spaces - Google shows it in 4-char
// groups for readability, strip those before pasting)
//
// Deploy: supabase functions deploy notify-client-update --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const HERO_URL = "https://www.anchordigitalco.com/assets/email-hero.jpg";
const LOGO_URL = "https://www.anchordigitalco.com/assets/anchor-icon.png";
const DASHBOARD_URL = "https://www.anchordigitalco.com/dashboard";

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
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
    if (!email || !message) {
      return json({ error: "email and message are required." }, 400);
    }

    const appPassword = Deno.env.get("GMAIL_APP_PASSWORD");
    const senderEmail = Deno.env.get("GMAIL_USER") || "adam@anchordigitalco.com";
    if (!appPassword) {
      return json({ error: "Email isn't configured yet (missing GMAIL_APP_PASSWORD secret)." }, 200);
    }

    const escapedMessage = escapeHtml(message).replace(/\n/g, "<br>");
    const greeting = companyName ? `Hi ${escapeHtml(companyName)},` : "Hi there,";

    const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background-color:#F2F0EC;">
  <div style="background-color:#F2F0EC;padding:32px 16px;font-family:'Inter',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background-color:#ffffff;border-collapse:separate;">
      <tr>
        <td style="background-color:#1F1E1C;background-image:url('${HERO_URL}');background-size:cover;background-position:center;padding:48px 40px;border-radius:20px 20px 0 0;text-align:center;">
          <p style="margin:0 0 10px;font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#ffffff;opacity:.85;">Project update</p>
          <h1 style="margin:0;font-size:26px;line-height:1.25;color:#ffffff;font-weight:600;">You have a new update</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:36px 40px 8px;">
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#131313;">${greeting}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F2F0EC;border-radius:14px;margin:0 0 18px;">
            <tr>
              <td style="padding:18px 20px;font-size:14px;line-height:1.6;color:#131313;">${escapedMessage}</td>
            </tr>
          </table>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#131313;">
            You can see this and everything else on your dashboard any time.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 40px 36px;text-align:center;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
            <tr>
              <td style="border-radius:99px;background-color:#131313;">
                <a href="${DASHBOARD_URL}" style="display:inline-block;padding:14px 32px;font-family:ui-monospace,Menlo,monospace;font-size:13px;letter-spacing:.5px;color:#ffffff;text-decoration:none;border-radius:99px;">View your dashboard</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 40px 32px;border-top:1px solid #ECEAE5;text-align:center;">
          <img src="${LOGO_URL}" width="140" height="74" alt="Anchor Digital" style="display:block;margin:0 auto 10px;">
          <p style="margin:0;font-size:11px;color:#A8A49D;">&copy; Anchor Digital Studio LLC.</p>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;

    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: senderEmail, password: appPassword },
      },
    });

    try {
      await client.send({
        from: `Anchor Digital <${senderEmail}>`,
        to: email,
        subject: "You have a new project update from Anchor Digital",
        html,
      });
    } finally {
      await client.close();
    }

    return json({ ok: true }, 200);
  } catch (err) {
    console.error("notify-client-update error:", err);
    return json({ error: "Could not send the update email." }, 200);
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
