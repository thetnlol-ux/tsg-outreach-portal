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

  // Merge into whatever's already cached rather than replace it - each run
  // only has budget to check a fraction of matched domains (see
  // MAX_DETAIL_LOOKUPS_PER_RUN in leadForensics.js), so overwriting
  // wholesale would forget every domain outside this run's own batch.
  const cacheRow = await env.DB.prepare("SELECT data FROM leadforensics_cache WHERE id = 1").first();
  const existingCache = cacheRow ? JSON.parse(cacheRow.data) : {};

  let result;
  try {
    result = await syncVisitsForDomains(env, targetDomains, existingCache);
  } catch (e) {
    return { synced: false, reason: "query_failed", detail: String((e && e.message) || e) };
  }

  const merged = { ...existingCache, ...result.updates };
  const dataText = JSON.stringify(merged);
  await env.DB.prepare(
    `INSERT INTO leadforensics_cache (id, data, synced_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at`
  ).bind(dataText, result.pulledOn).run();

  return {
    synced: true,
    processedThisRun: result.processedThisRun,
    remainingToCheck: result.remainingToCheck,
    matchedDomainsTotal: result.matchedDomainsTotal,
    totalCached: Object.keys(merged).length,
    pulledOn: result.pulledOn,
  };
}

export async function handleLeadForensicsSync(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  const result = await runLeadForensicsSync(env);
  return json(result, result.synced === false && result.reason === "query_failed" ? 502 : 200);
}
