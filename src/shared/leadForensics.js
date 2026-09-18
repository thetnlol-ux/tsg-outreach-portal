// Lead Forensics: identifies which real companies visited tapflopumps.co.uk
// (matched by IP/network, not cookies) - replaces the hand-pulled LF_VISITS
// snapshot baked into app.html on 17 Sep with a live sync.
//
// The API's shape only goes one direction: "who visited the site in this
// date range" (paginated, no name/domain filter), never "did company X
// visit" on demand - confirmed via their own docs (GetBusiness only takes
// a businessid, not a name or domain). So this can't be a per-lead "Check"
// button like Salesforce/ZoomInfo/Outlook - it has to page through every
// recent visitor and match by domain against the board, the same shape as
// the original hand sweep ("all ~241 companies... one real hit").
//
// Auth: two headers, not one - ClientID and Authorization-Token (neither
// is what the variable names LF_CLIENT_ID/LF_API_KEY would suggest; the
// "API key" is sent as Authorization-Token, confirmed against their real
// docs at https://leadforensics-api.readme.io/reference/testinput).
//
// Rate limit (their own docs): 5/sec, 50/min, 250/hour, 1000/day. A full
// sync pages through GetAllBusinesses at pagesize=1000 (confirmed working -
// ~90 days of Tapflo's traffic is ~5,900 businesses, so ~6 calls), then
// spends one GetVisitsByBusiness + one GetPagesByVisit call per genuine
// domain match only - real-world match counts are tiny (2 out of 241 on
// the original hand sweep), so this stays well inside the daily limit.

const BASE_URL = "https://interact.leadforensics.com/WebApi_v2";

function authHeaders(env) {
  return {
    ClientID: env.LEADFORENSICS_CLIENT_ID,
    "Authorization-Token": env.LEADFORENSICS_API_KEY,
    Accept: "application/json",
  };
}

// Their date format, confirmed from the docs' own example: "10-05-2016 00:00:00"
function lfDateStr(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

async function callApi(env, path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: authHeaders(env) });
  if (!res.ok) {
    throw new Error(`Lead Forensics API ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export async function getAllBusinesses(env, dateFrom, dateTo, pageNo, pageSize = 1000) {
  return callApi(env, "/Business/GetAllBusinesses", {
    datefrom: lfDateStr(dateFrom), dateto: lfDateStr(dateTo), pagesize: pageSize, pageno: pageNo,
  });
}

export async function getVisitsByBusiness(env, businessId, dateFrom, dateTo, pageSize = 5) {
  return callApi(env, "/Visit/GetVisitsByBusiness", {
    businessid: businessId, datefrom: lfDateStr(dateFrom), dateto: lfDateStr(dateTo), pagesize: pageSize, pageno: 1,
  });
}

// The first entry (earliest by PageVisitDateTime) is the landing page - per
// their own docs, not an assumption made here.
export async function getLandingPage(env, visitId) {
  const result = await callApi(env, "/Page/GetPagesByVisit", { visitid: visitId, pagesize: 20, pageno: 1 });
  const pages = (result.PageVisitList || []).slice().sort(
    (a, b) => new Date(a.PageVisitDateTime) - new Date(b.PageVisitDateTime)
  );
  return pages[0] || null;
}

function domainOf(website) {
  if (!website) return null;
  return String(website).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || null;
}

// A little under 5/sec to leave headroom for whatever else might be
// hitting this account's rate limit concurrently.
const CALL_DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pages through every business that visited in the window, matches by
// domain against targetDomains (a Set, lowercased, no "www."), and returns
// { [domain]: { visits: [{date, referrer, landedOn}], pulledOn } } - same
// shape as the LF_VISITS constant it replaces, so the frontend's existing
// lfLookup/lfVisitsSection/lfVisitChip need no changes beyond where the
// data comes from.
export async function syncVisitsForDomains(env, targetDomains, windowDays = 90) {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const pulledOn = dateTo.toISOString().slice(0, 10);

  const matchedBusinesses = [];
  let pageNo = 1;
  let pageCount = 1;
  do {
    const page = await getAllBusinesses(env, dateFrom, dateTo, pageNo);
    pageCount = page.PageCount || 1;
    for (const b of page.BusinessList || []) {
      const domain = domainOf(b.Website);
      if (domain && targetDomains.has(domain)) matchedBusinesses.push({ domain, business: b });
    }
    pageNo++;
    if (pageNo <= pageCount) await sleep(CALL_DELAY_MS);
  } while (pageNo <= pageCount);

  const visitsByDomain = {};
  for (const { domain, business } of matchedBusinesses) {
    await sleep(CALL_DELAY_MS);
    let visitResult;
    try {
      visitResult = await getVisitsByBusiness(env, business.BusinessID, dateFrom, dateTo);
    } catch (e) {
      continue; // couldn't pull this one's visits - leave it out rather than fabricate
    }
    const visits = (visitResult.SiteVisitList || [])
      .slice().sort((a, b) => new Date(b.StartDateTime) - new Date(a.StartDateTime));
    if (!visits.length) continue;

    const mostRecent = visits[0];
    let landedOn = null;
    try {
      await sleep(CALL_DELAY_MS);
      const landing = await getLandingPage(env, mostRecent.VisitID);
      landedOn = landing ? (landing.PageTitle || landing.PageLocation) : null;
    } catch (e) {
      // no landing page detail - the visit itself is still real, just less detailed
    }

    visitsByDomain[domain] = {
      visits: [{
        date: (mostRecent.StartDateTime || "").slice(0, 10),
        referrer: mostRecent.ReferrerName || null,
        landedOn,
      }],
      pulledOn,
    };
  }
  return { visitsByDomain, pulledOn, businessesScanned: matchedBusinesses.length };
}
