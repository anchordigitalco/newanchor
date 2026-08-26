// Portal login/signup, gated by reCAPTCHA.
//
// The portal calls Supabase Auth directly from the browser for everything
// else, but Supabase's own built-in CAPTCHA protection only supports
// Cloudflare Turnstile / hCaptcha, not Google reCAPTCHA. Since this project
// already has a working reCAPTCHA setup (shared with the contact form),
// this function stands in front of Auth just for this one step: verify the
// token server-side, then perform the same signInWithPassword ->
// (fallback) signUp sequence the client used to do directly, and hand back
// only the access/refresh token pair, never a password or the recaptcha
// secret. The client re-hydrates its own Supabase session from that pair
// via supabase.auth.setSession().
//
// Deploy: supabase functions deploy portal-auth --no-verify-jwt
// Secret: supabase secrets set RECAPTCHA_SECRET_KEY=... (already set for the contact form)

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyCaptcha(token: unknown): Promise<boolean> {
  const secret = Deno.env.get("RECAPTCHA_SECRET_KEY");
  if (!secret) {
    console.error("RECAPTCHA_SECRET_KEY is not set, rejecting.");
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

function pickSession(session: any) {
  if (!session) return null;
  return { access_token: session.access_token, refresh_token: session.refresh_token };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const redirectTo = typeof body.redirectTo === "string" ? body.redirectTo : undefined;

    if (!email || !password) {
      return json({ status: "error", error: "Email and password are required." }, 400);
    }
    if (password.length > 200) {
      return json({ status: "error", error: "That password is too long." }, 400);
    }

    if (!(await verifyCaptcha(body.recaptchaToken))) {
      return json({ status: "error", error: "reCAPTCHA verification failed, please try again." }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    // try logging in first
    const signInRes = await supabase.auth.signInWithPassword({ email, password });
    if (!signInRes.error && signInRes.data.session) {
      return json({ status: "signed_in", session: pickSession(signInRes.data.session) }, 200);
    }

    // no account yet for this (already allowlist-gated) email, or the password was
    // wrong - try creating the account. Supabase sends its own verification email
    // and won't issue a session until it's confirmed.
    const signUpRes = await supabase.auth.signUp({
      email,
      password,
      options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
    });

    if (!signUpRes.error) {
      if (signUpRes.data.session) {
        return json({ status: "signed_in", session: pickSession(signUpRes.data.session) }, 200);
      }
      return json({ status: "check_email" }, 200);
    }

    const msg = signUpRes.error.message || "";
    if (/registered|exists/i.test(msg)) {
      return json({ status: "error", error: "wrong_password" }, 200);
    }
    return json({ status: "error", error: msg }, 200);
  } catch (err) {
    console.error("portal-auth error:", err);
    return json({ status: "error", error: "Server error." }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
