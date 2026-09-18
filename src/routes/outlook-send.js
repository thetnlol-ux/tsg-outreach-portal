import { verifySession, readCookie } from "../shared/session.js";
import { sendOutlookMail } from "../shared/outlookMail.js";

// Real "Send Email" for Suggested Mailshots and the Cold Lead Action Desk -
// the one place in this portal that actually transmits an email, rather
// than copying/opening a draft for a human to send themselves. Always
// sends as the signed-in rep's own connected mailbox (never a shared/
// service identity): the recipient, subject and body are whatever the
// caller has on screen at the moment of clicking Send, edits included -
// this route trusts the client's content and just transmits it, the same
// way hitting Send in a real mail client would. contentType is "HTML" for
// the mailshot's rich template, "Text" for the cold-lead desk's plain-text
// draft - Graph needs to know which so a plain draft's line breaks aren't
// collapsed the way raw text dropped into an HTML body would be.
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function handleOutlookSend(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid JSON" }, 400);
  }
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const content = typeof body.body === "string" ? body.body : "";
  const contentType = body.contentType === "Text" ? "Text" : "HTML";
  if (!to || !to.includes("@") || to.length > 320) return json({ error: "invalid recipient" }, 400);
  if (!subject) return json({ error: "subject is required" }, 400);
  if (!content) return json({ error: "body is required" }, 400);

  const connection = await env.DB.prepare(
    "SELECT access_token, refresh_token FROM outlook_connections WHERE user_id = ?"
  )
    .bind(session.userId)
    .first();
  if (!connection) return json({ sent: false, reason: "not_connected" }, 400);

  try {
    await sendOutlookMail(env, session.userId, connection, { to, subject, body: content, contentType });
  } catch (e) {
    // Most likely cause right now: this connection predates the Mail.Send
    // scope and needs reconnecting - Graph rejects the token outright
    // rather than degrading, so surface it plainly instead of guessing.
    return json({ sent: false, reason: "send_failed", detail: String((e && e.message) || e) }, 502);
  }

  await env.DB.prepare("INSERT INTO activity_log (user_id, event) VALUES (?, 'outlook_email_sent')")
    .bind(session.userId)
    .run();

  return json({ sent: true });
}
