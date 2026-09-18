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
// Rate limit (their own docs): 5/sec, 50/min, 250/hour, 1000/day - comfortably
// enough for the call VOLUME here. The real constraint turned out to be
// Cloudflare's own per-invocation subrequest cap (50 fetch() calls per
// Worker request on the plans this account is on) - confirmed for real: a
// first live run against the actual board matched 152 unique domains
// (not the "2 of 241" the original hand sweep found, because that sweep
// only checked COLD leads while this checks every contact across both
// brands - a known customer's engineer researching a spec is a real,
// useful signal too, just a different kind), and the sync silently
// stopped after the first ~19 once the 50-subrequest budget (6 pagination
// calls + 2 per domain checked) ran out mid-run. So this can't fetch
// detail for every match in one invocation - see MAX_DETAIL_LOOKUPS_PER_RUN
// below, and syncVisitsForDomains's own comment for how it spreads
// coverage across repeated runs instead.

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

// Detail lookups (GetVisitsByBusiness + GetPagesByVisit, 2 calls each) per
// invocation. Budgeted to stay well under Cloudflare's 50-subrequest cap
// alongside the pagination scan (up to ~10 calls for a 90-day window in
// practice): 10 + 18*2 = 46. With ~150 real matches on this board, full
// coverage takes several runs, not one - see syncVisitsForDomains below
// for how that's spread out rather than silently truncated like the first
// live run was.
const MAX_DETAIL_LOOKUPS_PER_RUN = 18;

// Pages through every business that visited in the window (cheap - a
// handful of calls regardless of match count) and matches by domain
// against targetDomains (a Set, lowercased, no "www."). Detail lookups
// (the expensive part) are capped at MAX_DETAIL_LOOKUPS_PER_RUN per call,
// prioritising domains from existingCache that have never been checked or
// were checked longest ago - so repeated runs (the 6-hourly cron, or
// clicking "Sync" again) eventually cover every match in rotation instead
// of the same alphabetically-first few every time. Returns just the
// updates for domains actually processed this run - the caller merges
// them into its persisted cache rather than replacing it wholesale, or
// every run past the first would forget everything outside its own batch.
export async function syncVisitsForDomains(env, targetDomains, existingCache = {}, windowDays = 90) {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const pulledOn = dateTo.toISOString().slice(0, 10);

  const matchedByDomain = new Map(); // domain -> business; a company can have several Business rows (one per site/location) - first one wins
  let pageNo = 1;
  let pageCount = 1;
  do {
    const page = await getAllBusinesses(env, dateFrom, dateTo, pageNo);
    pageCount = page.PageCount || 1;
    for (const b of page.BusinessList || []) {
      const domain = domainOf(b.Website);
      if (domain && targetDomains.has(domain) && !matchedByDomain.has(domain)) matchedByDomain.set(domain, b);
    }
    pageNo++;
    if (pageNo <= pageCount) await sleep(CALL_DELAY_MS);
  } while (pageNo <= pageCount);

  // Never-checked domains (no entry, or no checkedAt on an old-shape entry)
  // sort first via "" - then oldest-checked-first among the rest.
  const orderedDomains = [...matchedByDomain.keys()].sort((a, b) => {
    const at = (existingCache[a] && existingCache[a].checkedAt) || "";
    const bt = (existingCache[b] && existingCache[b].checkedAt) || "";
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
  const toProcess = orderedDomains.slice(0, MAX_DETAIL_LOOKUPS_PER_RUN);

  const updates = {};
  for (const domain of toProcess) {
    const business = matchedByDomain.get(domain);
    await sleep(CALL_DELAY_MS);
    let visitResult;
    try {
      visitResult = await getVisitsByBusiness(env, business.BusinessID, dateFrom, dateTo);
    } catch (e) {
      continue; // couldn't check this one this run - leave its existing cache entry (if any) untouched rather than overwrite with nothing
    }
    const visits = (visitResult.SiteVisitList || [])
      .slice().sort((a, b) => new Date(b.StartDateTime) - new Date(a.StartDateTime));

    const checkedAt = new Date().toISOString();
    if (!visits.length) {
      updates[domain] = { visits: [], pulledOn, checkedAt };
      continue;
    }

    const mostRecent = visits[0];
    let landedOn = null;
    try {
      await sleep(CALL_DELAY_MS);
      const landing = await getLandingPage(env, mostRecent.VisitID);
      landedOn = landing ? (landing.PageTitle || landing.PageLocation) : null;
    } catch (e) {
      // no landing page detail - the visit itself is still real, just less detailed
    }

    updates[domain] = {
      visits: [{
        date: (mostRecent.StartDateTime || "").slice(0, 10),
        referrer: mostRecent.ReferrerName || null,
        landedOn,
      }],
      pulledOn,
      checkedAt,
    };
  }

  return {
    updates,
    pulledOn,
    matchedDomainsTotal: matchedByDomain.size,
    processedThisRun: toProcess.length,
    remainingToCheck: Math.max(0, matchedByDomain.size - toProcess.length),
  };
}
