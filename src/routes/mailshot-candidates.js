import { verifySession, readCookie } from "../shared/session.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Fast read of whatever the last sync produced, shaped exactly like the
// MAILSHOT_MATCHED/SALESFORCE_BLOCKED arrays it replaces so the frontend's
// existing rendering (msRow, msVisible, msContentFor etc.) needs no
// changes beyond where the data comes from.
export async function handleGetMailshotCandidates(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  const row = await env.DB.prepare("SELECT data, updated_at FROM mailshot_sync_state WHERE id = 1").first();
  if (!row) return json({ matched: null, blocked: null, updatedAt: null });

  const state = JSON.parse(row.data);
  const matched = Object.values(state.verified || {}).filter((v) => v.status === "candidate");
  const blocked = state.blockedByCrm || [];
  return json({ matched, blocked, updatedAt: row.updated_at });
}
