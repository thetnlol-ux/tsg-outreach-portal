import { verifySession, readCookie } from "../shared/session.js";
import { syncVisitsForDomains } from "../shared/leadForensics.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Every domain any current lead's contacts use (both brands), the same
// way the frontend's lfDomainOf() derives a domain from a contact email -
// mirrored here since this runs server-side against the live sync, not at
// render time.
function domainsFromLeads(leads) {
  const domains = new Set();
  for (const l of leads || []) {
    for (const c of l.contacts || []) {
      const m = (c.email || "").toLowerCase().match(/@([^\s>]+)$/);
      if (m) domains.add(m[1].replace(/^www\./, ""));
    }
  }
  return domains;
}

// The actual sync work, with no session/request dependency - shared by the
// authenticated HTTP route below and the scheduled (cron) handler in
// src/index.js, which has no signed-in user to check.
export async function runLeadForensicsSync(env) {
  if (!env.LEADFORENSICS_CLIENT_ID || !env.LEADFORENSICS_API_KEY) {
    return { synced: false, reason: "not_configured" };
  }

  const row = await env.DB.prepare("SELECT data FROM portal_state WHERE id = 1").first();
  const state = row ? JSON.parse(row.data) : {};
  const targetDomains = new Set([
    ...domainsFromLeads(state.tapfloLeads),
    ...domainsFromLeads(state.sychemLeads),
  ]);

  let result;
  try {
    result = await syncVisitsForDomains(env, targetDomains);
  } catch (e) {
    return { synced: false, reason: "query_failed", detail: String((e && e.message) || e) };
  }

  const dataText = JSON.stringify(result.visitsByDomain);
  await env.DB.prepare(
    `INSERT INTO leadforensics_cache (id, data, synced_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at`
  ).bind(dataText, result.pulledOn).run();

  return {
    synced: true,
    matchCount: Object.keys(result.visitsByDomain).length,
    businessesScanned: result.businessesScanned,
    pulledOn: result.pulledOn,
  };
}

export async function handleLeadForensicsSync(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  const result = await runLeadForensicsSync(env);
  return json(result, result.synced === false && result.reason === "query_failed" ? 502 : 200);
}
