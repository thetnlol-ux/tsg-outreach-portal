import { verifySession, readCookie } from "../shared/session.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Fast read of whatever the last sync produced - the frontend hydrates
// LF_VISITS from this the same way it hydrates tapfloLeads etc. from
// /api/state, falling back to the baked-in snapshot only if this has
// never run yet.
export async function handleGetLeadForensicsVisits(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  const row = await env.DB.prepare("SELECT data, synced_at FROM leadforensics_cache WHERE id = 1").first();
  if (!row) return json({ data: null, syncedAt: null });
  return json({ data: JSON.parse(row.data), syncedAt: row.synced_at });
}
