import { verifySession, readCookie } from "../shared/session.js";
import { resolveSalesforceOrg } from "../shared/salesforceOrgs.js";
import { runSoql } from "../shared/salesforce.js";

// The desk's first real live feature: "is this lead already a customer?",
// backed by the signed-in rep's own connected Salesforce org rather than
// the static, hand-verified note baked into the file at last edit.
// Deliberately returns candidate matches for a human to judge, not a
// boolean - a fuzzy company-name match is exactly the kind of thing that
// shouldn't silently decide anything on its own.
function escapeSoqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function handleSalesforceCheckAccount(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid JSON" }, 400);
  }
  const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
  if (!companyName || companyName.length > 200) {
    return json({ error: "invalid company name" }, 400);
  }

  const org = resolveSalesforceOrg(env, session.email);
  if (!org) {
    return json({ checked: false, reason: "org_not_configured" });
  }

  const connection = await env.DB.prepare(
    "SELECT instance_url, access_token, refresh_token FROM salesforce_connections WHERE user_id = ?"
  )
    .bind(session.userId)
    .first();
  if (!connection) {
    return json({ checked: false, reason: "not_connected" });
  }

  const soql = `SELECT Id, Name FROM Account WHERE Name LIKE '%${escapeSoqlString(companyName)}%' LIMIT 5`;
  try {
    const records = await runSoql(env, org, connection, session.userId, soql);
    return json({ checked: true, matches: records.map((r) => ({ id: r.Id, name: r.Name })) });
  } catch (e) {
    return json({ checked: false, reason: "query_failed", detail: String((e && e.message) || e) }, 502);
  }
}
