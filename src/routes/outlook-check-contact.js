import { verifySession, readCookie } from "../shared/session.js";
import { fetchRecentCorrespondence } from "../shared/outlookMail.js";

// Live "has this contact already been emailed?" check, using the rep's own
// connected Outlook mailbox - same pattern as the Salesforce/ZoomInfo
// checks: return candidate messages for a human to judge, never a silent
// boolean decision.
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function handleOutlookCheckContact(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid JSON" }, 400);
  }
  const contactEmail = typeof body.contactEmail === "string" ? body.contactEmail.trim() : "";
  if (!contactEmail || contactEmail.length > 320) {
    return json({ error: "invalid contact email" }, 400);
  }

  const connection = await env.DB.prepare(
    "SELECT 1 FROM outlook_connections WHERE user_id = ?"
  )
    .bind(session.userId)
    .first();
  if (!connection) return json({ checked: false, reason: "not_connected" });

  try {
    const messages = await fetchRecentCorrespondence(env, session.userId, contactEmail, 15);
    if (messages === null) {
      return json({ checked: false, reason: "unavailable" });
    }
    return json({ checked: true, messages });
  } catch (e) {
    return json({ checked: false, reason: "query_failed", detail: String((e && e.message) || e) }, 502);
  }
}
