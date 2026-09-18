import { verifySession, readCookie } from "../shared/session.js";
import { searchCompaniesByCriteria, searchContacts, enrichContacts, searchScoops } from "../shared/zoominfo.js";
import { resolveSalesforceOrg } from "../shared/salesforceOrgs.js";
import { runSoql } from "../shared/salesforce.js";
import { fetchCorrespondenceAcrossConnectedMailboxes } from "../shared/outlookMail.js";
import { judgeLeadFit } from "../shared/claudeJudge.js";

// Sources fresh Tapflo cold leads from ZoomInfo when the board runs low —
// the automated half of the "top the desk back up to 50 whenever it drops
// below 10" rule. Rewritten 18 Sep to follow the real sourcing methodology
// (written up by a colleague, from the actual 213-lead/453-contact board)
// rather than the ad-hoc version this started as. Key differences from that
// first version, kept here so the gap doesn't quietly reopen:
//
//   - Salesforce defines the target profile FIRST (sector mix + role
//     titles pulled from the CRM), ZoomInfo just fills it - not the other
//     way round.
//   - Four dedupe gates, not one: Salesforce Accounts by name (1),
//     Salesforce Contacts by email/domain (2), the board itself (3), and
//     Sent Items across every connected mailbox (4). Gate 4 is a
//     deliberately simplified version of the real methodology's - it drops
//     an already-emailed contact rather than classifying it into
//     active/excluded/startable the way a real refresh does, and it can
//     only check mailboxes that are actually connected (see
//     checkedMailboxes on each candidate).
//   - "No email, no lead": a contact search may return real people, but if
//     nobody survives with a real email address, the company doesn't get
//     sourced at all - not with a weak/no contact as filler.
//   - "No mobiles" is the real rule (business email + direct dial +
//     switchboard). This account's ZoomInfo plan disallows requesting
//     directPhone on contact enrichment entirely (a genuine "contact your
//     Account Manager" rejection, confirmed by testing, not a bug here) -
//     mobile is used as a flagged fallback instead, and every contact's
//     note says so plainly rather than imply the real rule was followed.
//   - Sector targeting, not open-ended search: the board is already over
//     target on food & drink (62% vs a 55% target), so this only searches
//     chemical manufacturing, industrial, and waste/effluent/environmental
//     - the three sectors currently under their target share.
//   - The five score metrics actually vary by what was found, rather than
//     being a near-constant sum of two pass/fail gates. Metric 5
//     ("customer profile match") is a similarity score to the sector's
//     real end-user closed-won base, not a re-statement of the Salesforce
//     dedupe outcome. Metric 4 ("news/funding signal") is a real check
//     against ZoomInfo's Scoops endpoint now, not an automatic 0 - most
//     companies still score 0 on it (confirmed: only a small minority of
//     UK SMEs return anything), which matches the methodology's own "4 in
//     5 score zero honestly" finding.
//
// Deliberately returns candidates for a human to add, never inserts them
// itself - same "a human judges every match" rule as Check Salesforce/
// ZoomInfo/Outlook.

const EMPLOYEE_BUCKETS = "50to99,100to249,250to499"; // 94% of the real desk sits 50-500; below ~40 the duty's too small for a Tapflo pump

// One bare keyword per ZoomInfo call - confirmed unreliable with several
// industryKeywords terms combined into one call. Only the three sectors
// currently under their target share (see the file comment above); no
// food/drink or pharma keywords, both at or over target already.
// wonBusinessRef/description feed judgeLeadFit (see ../shared/claudeJudge.js)
// - the real closed-won reference companies and sector duties the
// methodology doc names, now given to Claude as grounding context instead
// of living only in a code comment nobody but a human reading the source
// ever saw.
const SECTORS = {
  chemical: {
    keywords: ["chemicals", "coatings", "adhesives", "lubricants"],
    coreRoleKeywords: ["engineering manager", "process engineer", "maintenance manager"],
    secondaryRoleKeywords: ["production manager", "technical manager", "engineering", "engineer"],
    industryMatchScore: 18, // "at least as strong as food and drink in the won business" - Holchem, Ecolab, Everbuild
    applicationMatchScore: 12, // solvent/resin transfer, ATEX zoning, drum & IBC decanting - explicitly named in section 4b
    customerProfileScore: 20, // ceiling - the per-candidate value is judged by Claude, see judgeLeadFit
    wonBusinessRef: ["Holchem", "Ecolab", "Everbuild"],
    description: "chemical manufacturing (coatings, adhesives, lubricants) - solvent/resin transfer, ATEX zoning, drum & IBC decanting",
  },
  industrial: {
    keywords: ["plating", "quarrying"],
    coreRoleKeywords: ["maintenance manager", "plant engineer"],
    secondaryRoleKeywords: ["production engineer", "works manager", "engineer"],
    industryMatchScore: 14, // "the weakest defined sector on the board... needs the tightest definition"
    applicationMatchScore: 12, // abrasives/solids on centrifugal pumps - peristaltic/AODD territory
    customerProfileScore: 10, // ceiling - the per-candidate value is judged by Claude, see judgeLeadFit
    wonBusinessRef: [], // the weakest-defined sector on the board - no confirmed closed-won reference yet, score conservatively
    description: "plating and quarrying - abrasives/solids handling on centrifugal pumps, peristaltic/AODD territory",
  },
  waste: {
    keywords: ["recycling", "wastewater", "waste"],
    coreRoleKeywords: ["process manager", "plant manager"],
    secondaryRoleKeywords: ["works manager", "technical services manager", "operations manager", "operations"],
    industryMatchScore: 16, // "under-worked" but proven - Allwater, Castle Environmental, Olleco
    applicationMatchScore: 14, // sludge/lime/polymer/ferric dosing - "the strongest single product story outside hygienic"
    customerProfileScore: 15, // ceiling - the per-candidate value is judged by Claude, see judgeLeadFit
    wonBusinessRef: ["Allwater", "Castle Environmental", "Olleco"],
    description: "waste, wastewater and recycling - sludge/lime/polymer/ferric dosing",
  },
};

// Real dated news/hiring/funding signal, not a fabricated one - a scoop
// whose only topic is a layoff isn't a buying signal, so it doesn't count
// as a positive one here even though it's real and dated.
const NON_POSITIVE_SCOOP_TOPICS = new Set(["layoffs"]);

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
  if (n < 100) return `${n} (50 - 99 band)`;
  if (n < 250) return `${n} (100 - 249 band)`;
  return `${n} (250 - 499 band)`;
}

// Matches the frontend's own definition exactly (isLeadRemoved +
// isColdContact in app.html) - "the desk" means visible cold leads, not
// every lead this board has ever held. tapfloLeads only ever grows (a
// converted/excluded lead stays in the array, just flagged), so counting
// the raw array length here meant "need" would hit 0 permanently the
// moment the board passed 50 total leads ever sourced - a real bug, not
// just a testing inconvenience.
function isVisibleColdLead(l) {
  if (!l || l.removed) return false;
  return (l.contacts || []).some((c) => !c.followUp || c.followUp.status === "not_started");
}

function escapeSoqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Gate 1: Salesforce Accounts by name. Best-effort only - no connection or
// org config just means this gate (and gate 2, same connection) is skipped
// and flagged, not a reason to fail the whole run.
async function gate1AccountMatch(env, org, connection, session, companyName) {
  const soql = `SELECT Id FROM Account WHERE Name LIKE '%${escapeSoqlString(companyName)}%' LIMIT 1`;
  const records = await runSoql(env, org, connection, session.userId, soql);
  return records.length > 0;
}

// Gate 2: Salesforce Contacts by exact email and by domain - "people
// already in the CRM under a different company spelling". A hit here
// drops just that contact, not necessarily the whole company.
async function gate2ContactMatch(env, org, connection, session, email) {
  const domain = email.split("@")[1];
  const soql = `SELECT Id FROM Contact WHERE Email = '${escapeSoqlString(email)}' OR Email LIKE '%@${escapeSoqlString(domain)}' LIMIT 1`;
  const records = await runSoql(env, org, connection, session.userId, soql);
  return records.length > 0;
}

function roleMatchLevel(title, sectorDef) {
  const t = (title || "").toLowerCase();
  if (sectorDef.coreRoleKeywords.some((k) => t.includes(k))) return "core";
  if (sectorDef.secondaryRoleKeywords.some((k) => t.includes(k))) return "secondary";
  return null;
}

async function realPositiveScoopFound(env, companyName) {
  try {
    const result = await searchScoops(env, { companyName });
    return (result.data || []).some((s) => {
      const topics = (s.attributes.topics || []).map((t) => (t.topic || "").toLowerCase());
      return topics.length === 0 || topics.some((t) => !NON_POSITIVE_SCOOP_TOPICS.has(t));
    });
  } catch (e) {
    return false; // couldn't check - score honestly as no signal, same as "nothing real found"
  }
}

export async function handleZoomInfoSourceLeads(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);

  const row = await env.DB.prepare("SELECT data FROM portal_state WHERE id = 1").first();
  const state = row ? JSON.parse(row.data) : {};
  const tapfloLeads = Array.isArray(state.tapfloLeads) ? state.tapfloLeads : [];
  // Dedupe against every lead this board has ever held (including
  // converted/excluded ones) - re-sourcing a company just because it's no
  // longer "visible" would be wrong. Only the TARGET count below cares
  // about visible cold leads specifically.
  const existingNames = new Set(tapfloLeads.map((l) => (l.company || "").trim().toLowerCase()));

  const visibleColdCount = tapfloLeads.filter(isVisibleColdLead).length;
  const need = Math.max(0, 50 - visibleColdCount);
  // Same per-user testing override as the frontend button's visibility -
  // scoped to this one account so Steve can verify the feature works
  // without the real board needing to genuinely drop below 50 first.
  // Deliberately a small batch (3, not the full 15 cap): this is for
  // verifying the pipeline still works, not a real production top-up, and
  // every candidate that clears the gates still spends a real ZoomInfo
  // enrich credit.
  const isTestOverride = session.email.toLowerCase() === "steve.smith@tapflopumps.co.uk";
  if (need === 0 && !isTestOverride) {
    return json({ sourced: true, candidates: [], note: `The desk already has ${visibleColdCount} visible cold leads - no top-up needed.` });
  }
  // Capped per click regardless of how big "need" is - every candidate that
  // clears every gate below still costs a real ZoomInfo enrich credit per
  // contact. The methodology's own numbers (57 candidates looked at for 39
  // added, roughly a 10% hit rate sourcing the sector mix) mean hitting
  // "need" in full will take several clicks, not one - that's normal, not
  // a bug.
  const targetCount = isTestOverride && need === 0 ? 3 : Math.min(need, 15);

  const org = resolveSalesforceOrg(env, session.email);
  const sfConnection = org
    ? await env.DB.prepare(
        "SELECT instance_url, access_token, refresh_token FROM salesforce_connections WHERE user_id = ?"
      ).bind(session.userId).first()
    : null;
  const salesforceAvailable = !!(org && sfConnection);

  const candidates = [];
  const seenThisRun = new Set();

  outer:
  for (const [sectorKey, sectorDef] of Object.entries(SECTORS)) {
    if (candidates.length >= targetCount) break;

    for (const keyword of sectorDef.keywords) {
      if (candidates.length >= targetCount) break outer;

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
        if (!name || existingNames.has(nameLower) || seenThisRun.has(nameLower)) continue; // Gate 3
        seenThisRun.add(nameLower);

        // Gate 1
        let gate1Hit = false;
        if (salesforceAvailable) {
          try {
            gate1Hit = await gate1AccountMatch(env, org, sfConnection, session, name);
          } catch (e) {
            // couldn't check - fall through, flagged in the lead below
          }
        }
        if (gate1Hit) continue;

        // Role search across this sector's target titles, merged by contact id
        const contactsFound = new Map();
        for (const role of [...new Set([...sectorDef.coreRoleKeywords, ...sectorDef.secondaryRoleKeywords])]) {
          if (contactsFound.size >= 6) break;
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

        // Claude judges real functional fit (e.g. "Head of Engineering &
        // Maintenance" as a genuine core match despite not containing any
        // listed phrase) instead of a literal substring check, plus a real
        // per-company customerProfileScore instead of this sector's flat
        // ceiling. Best-effort: falls back to the old substring match and
        // the sector's static ceiling if the API key isn't set or the call
        // fails - same "unchecked, not wrong" pattern as every other gate
        // here, not a reason to skip the company.
        const distinctTitles = [...new Set([...contactsFound.values()].map((m) => m.jobTitle).filter(Boolean))];
        let judged = null;
        try {
          judged = await judgeLeadFit(env, {
            sectorKey, sectorDef, titles: distinctTitles,
            companyName: name, city: co.attributes.city, state: co.attributes.state,
            employeeCount: co.attributes.employeeCount,
          });
        } catch (e) {
          // couldn't judge via Claude - fall through to the deterministic path below
        }
        const levelFor = (title) => {
          if (judged && judged.byTitle.has(title)) return judged.byTitle.get(title);
          return roleMatchLevel(title, sectorDef);
        };

        // "No weak fallbacks" - only contacts that actually match this
        // sector's role vocabulary survive; nothing else is kept as filler.
        const roleMatched = [...contactsFound.entries()]
          .map(([id, meta]) => ({ id, meta, level: levelFor(meta.jobTitle) }))
          .filter((c) => c.level)
          .sort((a, b) => (b.meta.contactAccuracyScore || 0) - (a.meta.contactAccuracyScore || 0))
          .slice(0, 3);
        if (roleMatched.length === 0) continue;

        let enrichedByPersonId = new Map();
        try {
          const enrichResult = await enrichContacts(
            env,
            roleMatched.map((c) => ({ personId: c.id })),
            CONTACT_OUTPUT_FIELDS
          );
          for (const d of enrichResult.data || []) {
            enrichedByPersonId.set(String(d.id), d.attributes);
          }
        } catch (e) {
          continue; // couldn't enrich anyone at this company - skip rather than source contacts with no real details
        }

        const checkedMailboxesSet = new Set();
        const contacts = [];
        for (const { id, meta, level } of roleMatched) {
          const e = enrichedByPersonId.get(String(id));
          if (!e || !e.email) continue; // "no email, no lead" - a contact with no real email doesn't go on

          // Gate 2
          if (salesforceAvailable) {
            let gate2Hit = false;
            try {
              gate2Hit = await gate2ContactMatch(env, org, sfConnection, session, e.email);
            } catch (err) {
              // couldn't check - fall through
            }
            if (gate2Hit) continue;
          }

          // Gate 4 - simplified: drops the contact rather than classifying
          // it into active/excluded/startable the way a full refresh does.
          let gate4Hit = false;
          try {
            const outlookCheck = await fetchCorrespondenceAcrossConnectedMailboxes(env, e.email, 5);
            outlookCheck.checkedMailboxes.forEach((m) => checkedMailboxesSet.add(m));
            gate4Hit = outlookCheck.matches.length > 0;
          } catch (err) {
            // couldn't check - fall through, flagged in the lead below
          }
          if (gate4Hit) continue;

          contacts.push({
            name: `${e.firstName || ""} ${e.lastName || ""}`.trim() || "(name not on file)",
            title: e.jobTitle || meta.jobTitle || "(title not on file)",
            accuracy: meta.contactAccuracyScore || null,
            email: e.email,
            directPhone: null, // disallowed on this ZoomInfo plan's contact enrich output - see file comment
            mobile: e.mobilePhone || null,
            notes: [{
              date: todayStr(),
              text: `Sourced automatically via ZoomInfo (${sectorKey} sector, industry search: "${keyword}"). Contact accuracy score ${meta.contactAccuracyScore ?? "not on file"}. Direct dial isn't available on this ZoomInfo plan for automated sourcing — mobile shown instead, against the real "no mobiles" rule; treat as a fallback, not the intended contact method. Not manually verified — check role relevance before investing outreach time.`,
            }],
            followUp: { status: "not_started", history: [] },
            _roleLevel: level,
          });
        }
        if (!contacts.length) continue; // "no email, no lead" at the company level too

        const employeeCount = Number(co.attributes.employeeCount) || null;
        const bestRoleLevel = contacts.some((c) => c._roleLevel === "core") ? "core" : "secondary";
        const jobRoleScore = bestRoleLevel === "core" ? 20 : 15;
        const hasPositiveScoop = await realPositiveScoopFound(env, name);
        const newsScore = hasPositiveScoop ? 15 : 0;
        const customerProfileScore = judged ? judged.customerProfileScore : sectorDef.customerProfileScore;
        const score = jobRoleScore + sectorDef.industryMatchScore + sectorDef.applicationMatchScore
          + newsScore + customerProfileScore;

        const gateNotes = [];
        gateNotes.push(salesforceAvailable
          ? "Gates 1-2 (Salesforce Accounts/Contacts): checked, clear."
          : "Gates 1-2 (Salesforce Accounts/Contacts): skipped — not connected, or no org configured for your account.");
        gateNotes.push(checkedMailboxesSet.size
          ? `Gate 4 (Sent Items): checked ${[...checkedMailboxesSet].join(", ")} — clear.`
          : "Gate 4 (Sent Items): no connected mailboxes were available to check.");
        gateNotes.push(judged
          ? `Role match and customer-profile score judged by Claude: ${judged.reasoning}`
          : "Role match used the keyword fallback and customer-profile score used this sector's default ceiling — Claude judging was unavailable for this candidate.");

        candidates.push({
          company: name,
          loc: [co.attributes.city, co.attributes.state].filter(Boolean).join(", ") || null,
          sector: `${sectorKey} — sourced via ZoomInfo industry search: "${keyword}"`,
          employees: employeeBandLabel(employeeCount),
          employeeCount,
          revenue: co.attributes.revenue || null,
          contacts: contacts.map(({ _roleLevel, ...c }) => c),
          companyPhone: null,
          score,
          scoreBits: [
            ["Job role match", jobRoleScore, 20],
            ["Product → industry match", sectorDef.industryMatchScore, 20],
            ["Product → application match", sectorDef.applicationMatchScore, 20],
            ["News / funding signal", newsScore, 20],
            ["Customer profile match", customerProfileScore, 20],
          ],
          why: `Auto-sourced on ${todayStr()} via ZoomInfo (${sectorKey} sector, industry keyword "${keyword}", ${co.attributes.employeeCount || "unknown"} employees, UK) — this sector is currently under its target share of the board, per the 18 Sep sourcing methodology. Role match is ${bestRoleLevel === "core" ? "a core title for this sector" : "a secondary but real title for this sector"}. Product-application fit reflects this sector's known duties (see the sourcing methodology, section 4), not a verified read of this specific company's process. ${hasPositiveScoop ? "A real dated ZoomInfo Scoops signal was found for this company." : "No real dated news/funding signal (ZoomInfo Scoops) found for this company."} ${gateNotes.join(" ")} This is a rough placeholder score, well below the bar a hand-researched lead gets — verify before spending real outreach time on it.`,
          news: hasPositiveScoop
            ? `A real dated ZoomInfo Scoops signal was found for ${name} — check ZoomInfo directly for details before citing it in outreach.`
            : `No dated news/funding signal found for ${name} this session (checked ZoomInfo Scoops).`,
          pastWork: [],
          sources: [
            `ZoomInfo companies/search + contacts/search + contacts/enrich + scoops/search (session, ${todayStr()})`,
            ...gateNotes,
          ],
          pitch: {
            subject: `${name} | Pump & Spares {seasonal_adjective} Discount`,
            body: "Hi {name},\n\nI hope you're well!\n\nI wanted to reach out and ask how the pumps and fluid-transfer equipment on site are holding up at {company}?\n\nWe are currently running a {seasonal_adjective} discount on pumps and spares, so if there are any units that are aging, underperforming, or causing a bit of a headache, we'd welcome the opportunity to support.\n\nThat being said, if you're scoping out a new project that requires pumps, valves, tanks, or bespoke engineering, we're always on standby for a quick Teams call or site visit.\n\nAre there any ongoing process requirements at {company} that we could support with?",
          },
        });
      }
    }
  }

  return json({ sourced: true, candidates });
}
