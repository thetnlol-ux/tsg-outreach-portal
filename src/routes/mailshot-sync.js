import { verifySession, readCookie } from "../shared/session.js";
import { scanMailboxSentItems, hasRepliedSince, daysSince, COLD_GAP_DAYS } from "../shared/mailshotSourcing.js";
import { fetchContentLibrary, matchSubjectToContent } from "../shared/mailshotMatching.js";
import { searchCompaniesByCriteria } from "../shared/zoominfo.js";
import { runSoql } from "../shared/salesforce.js";

// Live replacement for the hand-pulled MAILSHOT_MATCHED (02 Sep) and
// SALESFORCE_BLOCKED (17 Sep) snapshots. Same two-phase shape as the
// ZoomInfo lead-sourcing rewrite and the Lead Forensics sync: a cheap
// broad discovery pass (Sent Items listing, no per-message calls) plus a
// capped, budgeted detail pass (reply-check, Salesforce check, company-
// name lookup) only for domains that clear the 40-day cold-gap threshold.
// Progress persists in mailshot_sync_state and resumes across runs - a
// large Sent Items history is expected to take several cron cycles or
// manual syncs to fully work through, exactly like Lead Forensics.

// Budgeted to stay comfortably under Cloudflare's 50-subrequest-per-
// invocation cap: discovery pagination is capped in mailshotSourcing.js
// (MAX_PAGES_PER_MAILBOX_PER_RUN, 5 pages x up to 3 connected mailboxes =
// 15 calls worst case), plus up to 3 calls per verified candidate here
// (reply-check, Salesforce check, ZoomInfo company-name lookup) - 10 * 3 =
// 30. 15 + 30 = 45, leaving headroom.
const MAX_CANDIDATES_PER_RUN = 10;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function getConnectedMailboxes(env) {
  const rows = await env.DB.prepare(
    `SELECT oc.user_id, oc.access_token, oc.refresh_token, u.email
     FROM outlook_connections oc JOIN users u ON u.id = oc.user_id`
  ).all();
  return rows.results || [];
}

// Background process, no signed-in session - reuses whichever Tapflo
// rep's Salesforce connection is available as the checking identity, same
// pattern as picking any connected mailbox for Lead Forensics-style
// checks. Best-effort: no connection just means this candidate's
// Salesforce status is flagged as unchecked, not that the whole run fails.
async function getServiceSalesforceConnection(env) {
  const org = {
    orgKey: "TAPFLO",
    loginDomain: env.SALESFORCE_DOMAIN_TAPFLO,
    clientId: env.SALESFORCE_CLIENT_ID_TAPFLO,
    clientSecret: env.SALESFORCE_CLIENT_SECRET_TAPFLO,
  };
  if (!org.loginDomain || !org.clientId || !org.clientSecret) return { org: null, connection: null };
  const connection = await env.DB.prepare(
    `SELECT sc.instance_url, sc.access_token, sc.refresh_token, sc.user_id
     FROM salesforce_connections sc WHERE sc.org_key = 'TAPFLO' LIMIT 1`
  ).first();
  return { org, connection };
}

function escapeSoqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function isSalesforceCustomer(env, org, connection, companyOrDomain) {
  if (!org || !connection) return null; // unchecked, not "no"
  const soql = `SELECT Id FROM Account WHERE Name LIKE '%${escapeSoqlString(companyOrDomain)}%' LIMIT 1`;
  try {
    const records = await runSoql(env, org, connection, connection.user_id, soql);
    return records.length > 0;
  } catch (e) {
    return null;
  }
}

async function lookupCompanyName(env, domain) {
  try {
    const result = await searchCompaniesByCriteria(env, { companyWebsite: domain });
    const match = (result.data || [])[0];
    return match ? match.attributes.name : null;
  } catch (e) {
    return null;
  }
}

function bandFor(gap) {
  if (gap >= 270) return "cold270";
  if (gap >= 120) return "cold120";
  return "cold40";
}

function defaultState() {
  return { mailboxes: {}, discovered: {}, verified: {}, blockedByCrm: [] };
}

export async function runMailshotSync(env, baseUrl) {
  const row = await env.DB.prepare("SELECT data FROM mailshot_sync_state WHERE id = 1").first();
  const state = row ? JSON.parse(row.data) : defaultState();
  state.mailboxes = state.mailboxes || {};
  state.discovered = state.discovered || {};
  state.verified = state.verified || {};
  state.blockedByCrm = state.blockedByCrm || [];

  const internalDomains = new Set(
    (env.ALLOWED_EMAIL_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
  );
  const alreadyKnownDomains = new Set([...Object.keys(state.discovered), ...Object.keys(state.verified)]);

  // Discovery: a capped page count per connected mailbox, resuming from
  // last run's cursor.
  const mailboxes = await getConnectedMailboxes(env);
  const discoveryNotes = [];
  for (const mb of mailboxes) {
    const priorCursor = state.mailboxes[mb.email] && state.mailboxes[mb.email].cursor;
    let scan;
    try {
      // Pass mb itself, not a copy - graphGet() mutates connection.access_token
      // in place on a 401 refresh, and the verification phase below reuses
      // this same mb object for hasRepliedSince(), which needs that refreshed
      // token rather than retrying the one already known to be stale.
      scan = await scanMailboxSentItems(env, mb.user_id, mb, internalDomains, alreadyKnownDomains, priorCursor);
    } catch (e) {
      discoveryNotes.push(`${mb.email}: scan failed (${String(e.message || e)})`);
      continue;
    }
    for (const [domain, rec] of Object.entries(scan.discovered)) {
      state.discovered[domain] = { ...rec, foundByMailbox: mb.email, foundByUserId: mb.user_id };
      alreadyKnownDomains.add(domain);
    }
    state.mailboxes[mb.email] = { cursor: scan.nextCursor, done: scan.done };
    discoveryNotes.push(`${mb.email}: scanned ${scan.pagesRead} page(s), ${Object.keys(scan.discovered).length} new domain(s)${scan.done ? " (reached the end of this mailbox's history)" : ""}`);
  }

  // Verification: only domains past the cold-gap threshold, not yet verified.
  const candidates = Object.entries(state.discovered)
    .filter(([domain, rec]) => !state.verified[domain] && daysSince(rec.lastSent) >= COLD_GAP_DAYS)
    .sort((a, b) => daysSince(b[1].lastSent) - daysSince(a[1].lastSent))
    .slice(0, MAX_CANDIDATES_PER_RUN);

  let library = null;
  try {
    library = await fetchContentLibrary(env, baseUrl);
  } catch (e) {
    // no content library available - candidates still get built, just without a topic match
  }
  const { org: sfOrg, connection: sfConnection } = await getServiceSalesforceConnection(env);

  for (const [domain, rec] of candidates) {
    const mailboxConn = mailboxes.find((mb) => mb.email === rec.foundByMailbox);
    const replied = mailboxConn
      ? await hasRepliedSince(env, rec.foundByUserId, mailboxConn, rec.recipientEmail, rec.lastSent)
      : null;

    if (replied === true) {
      state.verified[domain] = { status: "replied", ...rec, verifiedAt: new Date().toISOString() };
      continue;
    }

    const companyName = await lookupCompanyName(env, domain);
    const isCustomer = await isSalesforceCustomer(env, sfOrg, sfConnection, companyName || domain);
    if (isCustomer === true) {
      state.blockedByCrm.push({ company: companyName || domain, dom: domain, reason: "Matched an existing Salesforce Account" });
      state.verified[domain] = { status: "blocked_crm", ...rec, verifiedAt: new Date().toISOString() };
      continue;
    }

    const match = library ? matchSubjectToContent(rec.subject, library) : null;
    const gap = daysSince(rec.lastSent);
    const warn = [
      "Sourced automatically from Sent Items - only the most recent contact with this company is tracked, not a full send history.",
    ];
    if (replied === null) warn.push("Could not confirm whether they've replied since - worth checking the thread by hand before sending.");
    if (isCustomer === null) warn.push("Could not check Salesforce for this run - worth a manual check before sending.");
    if (!companyName) warn.push("Company name not confirmed via ZoomInfo - showing the email domain instead.");
    if (!match) warn.push("No confident topic/content match found for this subject line - pick a page by hand before sending.");

    state.verified[domain] = {
      status: "candidate",
      id: domain,
      co: companyName || domain,
      dom: domain,
      em: rec.recipientEmail,
      cn: rec.recipientName,
      cnGuess: rec.recipientName ? 0 : 1,
      rc: [[rec.recipientEmail, rec.recipientName]],
      last: (rec.lastSent || "").slice(0, 10),
      first: (rec.lastSent || "").slice(0, 10),
      gap,
      n: 1,
      rep: 0,
      topic: match ? match.topic : (rec.subject || ""),
      tech: match ? match.tech : null,
      band: bandFor(gap),
      why: match ? match.why : "No confident keyword match against the content library for this subject line.",
      tier: match ? match.tier : 2,
      c: match ? match.contentIndex : 0,
      nx: [],
      warn,
      forced: 0,
      verifiedAt: new Date().toISOString(),
    };
  }

  const dataText = JSON.stringify(state);
  await env.DB.prepare(
    `INSERT INTO mailshot_sync_state (id, data, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(dataText).run();

  const verifiedCandidates = Object.values(state.verified).filter((v) => v.status === "candidate");
  const stillToVerify = Object.keys(state.discovered).filter(
    (d) => !state.verified[d] && daysSince(state.discovered[d].lastSent) >= COLD_GAP_DAYS
  ).length;

  return {
    synced: true,
    mailboxesScanned: mailboxes.length,
    discoveryNotes,
    domainsDiscovered: Object.keys(state.discovered).length,
    candidatesVerifiedThisRun: candidates.length,
    totalCandidates: verifiedCandidates.length,
    stillToVerify,
  };
}

export async function handleMailshotSync(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return json({ error: "unauthenticated" }, 401);
  const result = await runMailshotSync(env, request.url);
  return json(result);
}
