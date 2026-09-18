import { verifySession, readCookie } from "../shared/session.js";
import { searchCompany } from "../shared/zoominfo.js";

// Live company data from ZoomInfo, to compare against the static
// size/revenue/location baked into the lead at last edit. Deliberately
// uses only the free Search endpoint, not the paid per-record Enrich call
// - Search already returns size/revenue/location/website, which is
// everything this check needs, at zero credit cost per click.
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function handleZoomInfoCheckCompany(request, env) {
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

  try {
    const result = await searchCompany(env, { companyName }, { pageSize: 5 });
    const matches = (result.data || []).map((d) => ({
      id: d.id,
      name: d.attributes.name,
      website: d.attributes.website,
      city: d.attributes.city,
      state: d.attributes.state,
      country: d.attributes.country,
      employeeCount: d.attributes.employeeCount,
      revenue: d.attributes.revenue,
    }));
    return json({ checked: true, matches });
  } catch (e) {
    return json({ checked: false, reason: "query_failed", detail: String((e && e.message) || e) }, 502);
  }
}
