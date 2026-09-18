import { verifySession, readCookie } from "../shared/session.js";
import { searchCompaniesByCriteria, searchContacts, enrichContacts } from "../shared/zoominfo.js";
import { resolveSalesforceOrg } from "../shared/salesforceOrgs.js";
import { runSoql } from "../shared/salesforce.js";

// Sources fresh Tapflo cold leads from ZoomInfo when the board runs low —
// the automated half of the "top the desk back up to 50 whenever it drops
// below 10" rule (see the 11 Sep footnote on the Tapflo column). Tapflo
// only: Sychem's Salesforce dedupe has a known licensing gap, and its
// targeting criteria (quality/technical/decontamination roles) haven't been
// worked out here yet.
//
// Deliberately returns candidates for a human to add, never inserts them
// itself - same "a human judges every match" rule as Check Salesforce/
// ZoomInfo/Outlook. What IS automatic here, because the user asked for it:
// contact enrichment (real email/phone, a paid ZoomInfo credit per
// contact) and a first-pass score/draft, so a reviewer sees a usable lead
// tile rather than a bare company name.
//
// Honesty matters more here than on a hand-researched lead: nothing below
// invents a fact. Two of the five score metrics (product-application fit,
// news/funding signal) are scored 0 because they genuinely weren't
// checked - no human or model has read what each company actually makes,
// and no news source is wired in. Say so plainly in "why", the same way
// the rest of this board handles "nothing real was found".

const KEYWORDS = [
  "Food Production",
  "food manufacturer",
  "beverage manufacturer",
  "dairy",
  "brewery",
  "distillery",
  "chemical manufacturer",
  "specialty chemicals",
  "pharmaceutical manufacturer",
];
const EMPLOYEE_BUCKETS = "20to49,50to99,100to249,250to499";
const ROLE_SEARCHES = ["Engineering Manager", "Production Manager", "Maintenance Manager", "Process Manager"];
const ROLE_KEYWORDS = ["engineer", "engineering", "process", "production", "maintenance"];

const CONTACT_OUTPUT_FIELDS = [
  "id", "firstName", "lastName", "email", "jobTitle", "phone", "mobilePhone", "managementLevel",
];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function employeeBandLabel(employeeCount) {
  const n = Number(employeeCount);
  if (!Number.isFinite(n)) return null;
  if (n < 50) return `${n} (20 - 49 band)`;
  if (n < 100) return `${n} (50 - 99 band)`;
  if (n < 250) return `${n} (100 - 249 band)`;
  return `${n} (250 - 499 band)`;
}

function escapeSoqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Best-effort only: no Salesforce connection or org config just means this
// check is skipped (flagged in "why"), not a reason to fail the whole
// sourcing run - the same degrade-gracefully rule outlookMail.js follows.
async function alreadyCustomerInSalesforce(env, session, companyName) {
  const org = resolveSalesforceOrg(env, session.email);
  if (!org) return { checked: false };
  const connection = await env.DB.prepare(
    "SELECT instance_url, access_token, refresh_token FROM salesforce_connections WHERE user_id = ?"
  )
    .bind(session.userId)
    .first();
  if (!connection) return { checked: false };

  const soql = `SELECT Id FROM Account WHERE Name LIKE '%${escapeSoqlString(companyName)}%' LIMIT 1`;
  try {
    const records = await runSoql(env, org, connection, session.userId, soql);
    return { checked: true, isCustomer: records.length > 0 };
  } catch (e) {
    return { checked: false };
  }
}

export async function handleZoomInfoSourceLeads(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  const row = await env.DB.prepare("SELECT data FROM portal_state WHERE id = 1").first();
  const state = row ? JSON.parse(row.data) : {};
  const tapfloLeads = Array.isArray(state.tapfloLeads) ? state.tapfloLeads : [];
  const existingNames = new Set(tapfloLeads.map((l) => (l.company || "").trim().toLowerCase()));

  const need = Math.max(0, 50 - tapfloLeads.length);
  if (need === 0) {
    return json({ sourced: true, candidates: [], note: "Board is already at 50 or more Tapflo leads." });
  }
  // Capped per click, regardless of how big "need" is - each candidate that
  // clears the company/contact/Salesforce filters below costs real ZoomInfo
  // enrich credits, so one click should never silently spend for all 40+
  // missing leads at once. Click again for more.
  const targetCount = Math.min(need, 15);

  const candidates = [];
  const seenThisRun = new Set();

  outer:
  for (const keyword of KEYWORDS) {
    let companySearch;
    try {
      companySearch = await searchCompaniesByCriteria(env, {
        country: "United Kingdom",
        industryKeywords: keyword,
        employeeCount: EMPLOYEE_BUCKETS,
      });
    } catch (e) {
      continue; // one bad keyword shouldn't sink the whole sourcing run
    }

    for (const co of companySearch.data || []) {
      if (candidates.length >= targetCount) break outer;

      const name = (co.attributes.name || "").trim();
      const nameLower = name.toLowerCase();
      if (!name || existingNames.has(nameLower) || seenThisRun.has(nameLower)) continue;
      seenThisRun.add(nameLower);

      const customerCheck = await alreadyCustomerInSalesforce(env, session, name);
      if (customerCheck.checked && customerCheck.isCustomer) continue; // already a customer - don't source it as cold

      // Try each target role in turn, merging by contact id, until we have
      // a couple of real candidates or run out of roles to try.
      const contactsFound = new Map();
      for (const role of ROLE_SEARCHES) {
        if (contactsFound.size >= 3) break;
        let contactSearch;
        try {
          contactSearch = await searchContacts(env, { companyName: name, jobTitle: role });
        } catch (e) {
          continue;
        }
        for (const c of contactSearch.data || []) {
          if (!contactsFound.has(c.id)) contactsFound.set(c.id, c.attributes);
        }
      }
      if (contactsFound.size === 0) continue; // no matching role found here - not worth sourcing

      const topContacts = [...contactsFound.entries()]
        .sort((a, b) => (b[1].contactAccuracyScore || 0) - (a[1].contactAccuracyScore || 0))
        .slice(0, 3);

      let enrichedByPersonId = new Map();
      try {
        const enrichResult = await enrichContacts(
          env,
          topContacts.map(([id]) => ({ personId: id })),
          CONTACT_OUTPUT_FIELDS
        );
        for (const d of enrichResult.data || []) {
          enrichedByPersonId.set(String(d.id), d.attributes);
        }
      } catch (e) {
        continue; // couldn't enrich anyone at this company - skip rather than source contacts with no real details
      }

      const contacts = topContacts
        .map(([id, meta]) => {
          const e = enrichedByPersonId.get(String(id));
          if (!e) return null;
          const roleMatches = ROLE_KEYWORDS.some((k) => (e.jobTitle || "").toLowerCase().includes(k));
          return {
            name: `${e.firstName || ""} ${e.lastName || ""}`.trim() || "(name not on file)",
            title: e.jobTitle || meta.jobTitle || "(title not on file)",
            accuracy: meta.contactAccuracyScore || null,
            email: e.email || null,
            directPhone: null, // disallowed on this ZoomInfo plan's contact enrich output
            mobile: e.mobilePhone || null,
            notes: [{
              date: todayStr(),
              text: `Sourced automatically via ZoomInfo (industry search: "${keyword}"). Contact accuracy score ${meta.contactAccuracyScore ?? "not on file"}. Not manually verified — check role relevance before investing outreach time.`,
            }],
            followUp: { status: "not_started", history: [] },
            _roleMatch: roleMatches,
          };
        })
        .filter(Boolean);
      if (!contacts.length) continue;

      const employeeCount = Number(co.attributes.employeeCount) || null;
      const jobRoleScore = contacts.some((c) => c._roleMatch) ? 20 : 10;
      const customerProfileScore = customerCheck.checked ? 20 : 10; // full marks only when the Salesforce check actually ran clean
      const score = jobRoleScore + 15 + 0 + 0 + customerProfileScore;

      const salesforceNote = customerCheck.checked
        ? "Cross-checked against Salesforce Accounts: no match found."
        : "Salesforce cross-check was skipped (not connected, or no org configured for your account) — worth checking by hand before outreach.";

      candidates.push({
        company: name,
        loc: [co.attributes.city, co.attributes.state].filter(Boolean).join(", ") || null,
        sector: `Sourced via ZoomInfo industry search: "${keyword}"`,
        employees: employeeBandLabel(employeeCount),
        employeeCount,
        revenue: co.attributes.revenue || null,
        contacts: contacts.map(({ _roleMatch, ...c }) => c),
        companyPhone: null,
        score,
        scoreBits: [
          ["Job role match", jobRoleScore, 20],
          ["Product → industry match", 15, 20],
          ["Product → application match", 0, 20],
          ["News / funding signal", 0, 20],
          ["Customer profile match", customerProfileScore, 20],
        ],
        why: `Auto-sourced on ${todayStr()} via ZoomInfo company search (industry keyword "${keyword}", ${co.attributes.employeeCount || "unknown"} employees, UK). Role match and company size were checked programmatically; product-application fit was NOT checked — nobody has confirmed what fluids or processes this company actually runs, so treat that score honestly as unverified. ${salesforceNote} This is a rough placeholder score, well below the bar a hand-researched lead gets — verify before spending real outreach time on it.`,
        news: `No dated news/funding signal found for ${name} this session — sourced automatically, no news search was run.`,
        pastWork: [],
        sources: [
          `ZoomInfo companies/search + contacts/search + contacts/enrich (session, ${todayStr()})`,
          salesforceNote,
        ],
        pitch: {
          subject: `${name} | Pump & Spares {seasonal_adjective} Discount`,
          body: "Hi {name},\n\nI hope you're well!\n\nI wanted to reach out and ask how the pumps and fluid-transfer equipment on site are holding up at {company}?\n\nWe are currently running a {seasonal_adjective} discount on pumps and spares, so if there are any units that are aging, underperforming, or causing a bit of a headache, we'd welcome the opportunity to support.\n\nThat being said, if you're scoping out a new project that requires pumps, valves, tanks, or bespoke engineering, we're always on standby for a quick Teams call or site visit.\n\nAre there any ongoing process requirements at {company} that we could support with?",
        },
      });
    }
  }

  return json({ sourced: true, candidates });
}
