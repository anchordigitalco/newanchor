// Anchor Digital studio assistant.
//
// Holds ANTHROPIC_API_KEY server-side (set via `supabase secrets set`, never
// shipped to the browser) and proxies chat messages to Claude. Requires the
// caller to be a real logged-in client, not just anyone holding the public
// anon key, verified below via their auth JWT.
//
// Deploy: supabase functions deploy studio-assistant
// Secret: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.14";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NOTIFY_RECIPIENTS = ["adam@anchordigitalco.com", "jackson@anchordigitalco.com"];

// Adam/Jackson get an email every time a client sends the assistant a
// message, so a real question doesn't just sit unread in the admin panel.
// Best-effort: a failed notification never blocks the client's own reply.
async function notifyNewMessage(who: string, message: string, reply: string) {
  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!gmailUser || !gmailPass) {
    console.error("GMAIL_USER/GMAIL_APP_PASSWORD not set, skipping message notification.");
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: `Anchor Digital Portal <${gmailUser}>`,
      to: NOTIFY_RECIPIENTS,
      subject: `New portal message from ${who}`,
      text: `${who} just messaged the studio assistant:\n\n"${message}"\n\nThe assistant replied:\n\n"${reply}"\n\nFull conversation history: check the Messages tab in the admin portal.`,
    });
  } catch (err) {
    console.error("message notification email error:", err);
  }
}

const SYSTEM_PROMPT = `You are the Anchor Digital studio assistant, embedded in a client's
project portal. Anchor Digital is a small web design/development studio run by Adam and
Jackson (contact: adam@anchordigitalco.com, jackson@anchordigitalco.com).

Be brief, direct, and honest. Only state specifics about this client's project if they
appear in the "client project data" block below. If you don't have real data on something
they ask (timelines, pricing, scope changes, anything you're not certain of), say so
plainly and tell them to reach Adam or Jackson directly, don't guess or make anything up.`;

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
      return json({ error: "Please log in to use the assistant." }, 401);
    }
    const user = userData.user;

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return json({ reply: "The assistant isn't fully set up yet (missing API key on the server side). Email adam@anchordigitalco.com in the meantime." }, 200);
    }

    const body = await req.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = Array.isArray(body.history) ? body.history : [];
    if (!message) {
      return json({ error: "Empty message." }, 400);
    }
    if (message.length > 4000) {
      return json({ error: "That message is too long, try breaking it up." }, 400);
    }

    // cheap cost-control guard: cap how many messages one client can send
    // per hour, protects the Anthropic bill from a bug or abuse, not just
    // from malice
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount, error: countError } = await supabaseAdmin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("client_id", user.id)
      .eq("role", "user")
      .gte("created_at", oneHourAgo);
    if (countError) console.error("rate limit check error:", countError);
    if ((recentCount ?? 0) >= 40) {
      return json({ reply: "You've sent a lot of messages in the last hour, give it a little while and try again. If it's urgent, email adam@anchordigitalco.com." }, 200);
    }

    // pull this client's real project data so the assistant can answer honestly
    // instead of guessing, grounded only in what's actually in the database
    const [{ data: profile }, { data: project }, { data: activity }] = await Promise.all([
      supabaseAdmin.from("profiles").select("company_name").eq("id", user.id).maybeSingle(),
      supabaseAdmin.from("projects").select("status,next_milestone,open_items,last_update_at").eq("client_id", user.id).maybeSingle(),
      supabaseAdmin.from("activity").select("message,created_at").eq("client_id", user.id).order("created_at", { ascending: false }).limit(5),
    ]);

    const context = {
      company_name: profile?.company_name ?? null,
      project: project ?? "no project record yet",
      recent_activity: activity ?? [],
    };

    const messages = [
      ...history
        .filter((m: any) =>
          m && typeof m === "object"
          && (m.role === "user" || m.role === "assistant")
          && typeof m.content === "string"
        )
        .slice(-10)
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
      { role: "user", content: message },
    ];

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: `${SYSTEM_PROMPT}\n\nClient project data:\n${JSON.stringify(context, null, 2)}`,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return json({ reply: "Something went wrong reaching the assistant just now, try again in a moment, or email adam@anchordigitalco.com." }, 200);
    }

    const data = await anthropicRes.json();
    const reply = data?.content?.[0]?.text ?? "Sorry, I couldn't put together a reply to that.";

    // log both sides for the admin "Messages" view. Awaited (not
    // fire-and-forget) because the edge runtime can tear down the isolate
    // right after the response is sent, which would silently drop an
    // un-awaited insert.
    const { error: logError } = await supabaseAdmin.from("messages").insert([
      { client_id: user.id, role: "user", content: message },
      { client_id: user.id, role: "assistant", content: reply },
    ]);
    if (logError) console.error("message log error:", logError);

    const who = profile?.company_name || user.email || "A client";
    await notifyNewMessage(who, message, reply);

    return json({ reply }, 200);
  } catch (err) {
    console.error("studio-assistant error:", err);
    return json({ error: "Server error." }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
