// Public contact-form handler. No login required (visitors aren't
// authenticated), protected instead by input validation, reCAPTCHA, and a
// database-backed rate limit (durable across cold starts, unlike an
// in-memory counter).
//
// Deploy: supabase functions deploy submit-contact-form --no-verify-jwt
// Secrets:
//   supabase secrets set GMAIL_USER=adam@anchordigitalco.com
//   supabase secrets set GMAIL_APP_PASSWORD=...
//   supabase secrets set RECAPTCHA_SECRET_KEY=...

import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.14";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RECIPIENTS = ["adam@anchordigitalco.com", "jackson@anchordigitalco.com"];
const MAX_SHORT = 200;
const MAX_LONG = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

// every field lands in an HTML email verbatim below, without this a
// submission containing `<script>` or a stray `<img onerror=...>` would
// render as live HTML in whoever's inbox reads it, not as plain text
function escapeHtml(value: unknown): string {
  if (value === undefined || value === null || value === "") return "(none)";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validate(data: Record<string, unknown>): string | null {
  if (typeof data.name !== "string" || !data.name.trim()) return "Name is required.";
  if (data.name.length > MAX_SHORT) return "Name is too long.";
  if (typeof data.email !== "string" || !EMAIL_RE.test(data.email)) return "A valid email is required.";
  if (data.email.length > MAX_SHORT) return "Email is too long.";
  for (const field of ["business", "type", "budget", "timeline"] as const) {
    if (data[field] !== undefined && (typeof data[field] !== "string" || (data[field] as string).length > MAX_SHORT)) {
      return "One of the fields is too long.";
    }
  }
  if (typeof data.message !== "string" || !data.message.trim()) return "Message is required.";
  if ((data.message as string).length > MAX_LONG) return "Message is too long.";
  return null;
}

// the client-side checkbox only proves someone clicked it, this is the
// actual enforcement: the token is redeemed against Google's own endpoint
// using the secret key, which only Google and this server ever see
async function verifyCaptcha(token: unknown): Promise<boolean> {
  const secret = Deno.env.get("RECAPTCHA_SECRET_KEY");
  if (!secret) {
    console.error("RECAPTCHA_SECRET_KEY is not set, rejecting submission.");
    return false;
  }
  if (typeof token !== "string" || !token) return false;

  const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, response: token }),
  });
  const result = await res.json();
  return result.success === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // durable per-IP rate limit: count recent attempts, then log this one,
    // regardless of whether it ends up valid, matching the original design
    const windowStart = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count: recentCount, error: countError } = await supabaseAdmin
      .from("contact_rate_limit")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("created_at", windowStart);
    if (countError) console.error("rate limit check error:", countError);

    await supabaseAdmin.from("contact_rate_limit").insert({ ip });

    if ((recentCount ?? 0) >= RATE_LIMIT) {
      return json({ error: "Too many submissions, please try again later." }, 429);
    }

    const data = await req.json().catch(() => ({}));

    const validationError = validate(data);
    if (validationError) {
      return json({ error: validationError }, 400);
    }

    if (!(await verifyCaptcha(data.recaptchaToken))) {
      return json({ error: "reCAPTCHA verification failed, please try again." }, 400);
    }

    const gmailUser = Deno.env.get("GMAIL_USER");
    const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!gmailUser || !gmailPass) {
      console.error("GMAIL_USER/GMAIL_APP_PASSWORD not set.");
      return json({ error: "Email sending isn't configured yet." }, 500);
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });

    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #1F1E1C; color: #F2F0EC; border-radius: 8px;">
        <h2 style="color: #F2F0EC; margin-bottom: 4px;">New Project Inquiry</h2>
        <p style="color: #A8A49D; margin-top: 0; margin-bottom: 24px; font-size: 14px;">Submitted via anchordigitalco.com</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr><td style="padding: 10px 0; border-bottom: 1px solid #3a3733; color: #A8A49D; width: 40%;">Name</td><td style="padding: 10px 0; border-bottom: 1px solid #3a3733;">${escapeHtml(data.name)}</td></tr>
          <tr><td style="padding: 10px 0; border-bottom: 1px solid #3a3733; color: #A8A49D;">Email</td><td style="padding: 10px 0; border-bottom: 1px solid #3a3733;">${escapeHtml(data.email)}</td></tr>
          <tr><td style="padding: 10px 0; border-bottom: 1px solid #3a3733; color: #A8A49D;">Business</td><td style="padding: 10px 0; border-bottom: 1px solid #3a3733;">${escapeHtml(data.business)}</td></tr>
          <tr><td style="padding: 10px 0; border-bottom: 1px solid #3a3733; color: #A8A49D;">Looking for</td><td style="padding: 10px 0; border-bottom: 1px solid #3a3733;">${escapeHtml(data.type)}</td></tr>
          <tr><td style="padding: 10px 0; border-bottom: 1px solid #3a3733; color: #A8A49D;">Budget</td><td style="padding: 10px 0; border-bottom: 1px solid #3a3733;">${escapeHtml(data.budget)}</td></tr>
          <tr><td style="padding: 10px 0; border-bottom: 1px solid #3a3733; color: #A8A49D;">Timeline</td><td style="padding: 10px 0; border-bottom: 1px solid #3a3733;">${escapeHtml(data.timeline)}</td></tr>
          <tr><td style="padding: 10px 0; color: #A8A49D; vertical-align: top;">Message</td><td style="padding: 10px 0;">${escapeHtml(data.message)}</td></tr>
        </table>
        <div style="margin-top: 24px; padding: 16px; background: #2a2825; border-radius: 6px; font-size: 13px; color: #A8A49D;">
          Reply to this email to reach the client at ${escapeHtml(data.email)}.
        </div>
      </div>
    `;

    await transporter.sendMail({
      // the "From" address has to match the authenticated Gmail account or
      // Gmail silently rewrites/flags it, which can bounce or spam-fold the
      // message. Recipients (the inboxes this actually needs to land in)
      // are set separately below and are unaffected by this.
      from: `Anchor Digital <${gmailUser}>`,
      to: RECIPIENTS,
      replyTo: String(data.email),
      subject: `New Inquiry: ${data.name || "Unknown"}${data.type ? " - " + data.type : ""}`,
      html,
    });

    return json({ success: true }, 200);
  } catch (err) {
    // logged in full server-side; the client only ever gets a generic
    // message so internal error text/library details can't leak out
    console.error("submit-contact-form error:", err);
    return json({ error: "Something went wrong. Please try again, or email us directly." }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
