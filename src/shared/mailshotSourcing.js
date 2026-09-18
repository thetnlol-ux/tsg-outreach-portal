// Live replacement for the hand-pulled MAILSHOT_MATCHED snapshot (dated
// 02 Sep) in app.html: scans Sent Items across every connected mailbox to
// find companies cold-outreached more than 40 days ago with no reply since.
//
// Same auth pattern as outlookMail.js (reused, not reinvented) - certificate
// credential refresh, one connection row per rep. Two real constraints this
// is designed around from the start, both learned the hard way on the Lead
// Forensics sync:
//   - Cloudflare caps fetch() calls at ~50 per Worker invocation. Sent Items
//     across three mailboxes over ~2 years could be thousands of messages,
//     so this pages through a CAPPED number of pages per run and resumes
//     from a persisted cursor (nextLink) next time - full historical
//     coverage takes several sync cycles, not one.
//   - Only genuine candidates (gap > 40 days) get the expensive per-domain
//     reply-check - the broad discovery pass itself is cheap (Graph returns
//     subject/recipients/date in the listing, no extra call per message).
import { refreshOutlookToken } from "./outlookMail.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const COLD_GAP_DAYS = 40;
const MAX_PAGES_PER_MAILBOX_PER_RUN = 5; // 5 pages x up to 3 mailboxes = 15 calls, leaves room for verification calls in the same run's 50-subrequest budget
const PAGE_SIZE = 50;

async function graphGet(env, connection, userId, url) {
  const doFetch = (token) => fetch(url, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" } });
  let res = await doFetch(connection.access_token);
  if (res.status === 401) {
    const refreshed = await refreshOutlookToken(env, connection);
    await env.DB.prepare(
      "UPDATE outlook_connections SET access_token = ?, refresh_token = ?, updated_at = datetime('now') WHERE user_id = ?"
    ).bind(refreshed.accessToken, refreshed.refreshToken, userId).run();
    connection.access_token = refreshed.accessToken;
    res = await doFetch(refreshed.accessToken);
  }
  if (!res.ok) throw new Error(`Graph request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function domainOf(email) {
  const m = (email || "").toLowerCase().match(/@([^\s>]+)$/);
  return m ? m[1] : null;
}

// One page of a mailbox's Sent Items, newest first - cheap: subject,
// recipients and date all come back in the listing itself, no per-message
// detail call needed for the discovery pass.
async function fetchSentItemsPage(env, connection, userId, nextLink) {
  const url = nextLink || `${GRAPH_BASE}/me/mailFolders('SentItems')/messages` +
    `?$select=subject,toRecipients,sentDateTime,conversationId` +
    `&$top=${PAGE_SIZE}&$orderby=sentDateTime desc`;
  return graphGet(env, connection, userId, url);
}

// Scans up to MAX_PAGES_PER_MAILBOX_PER_RUN pages of one mailbox's Sent
// Items, recording the first (= most recent, since newest-first) external
// recipient domain it sees for each company - later, older pages never
// overwrite an already-recorded domain, so this stays correct across
// resumed runs regardless of where the cursor currently is.
export async function scanMailboxSentItems(env, userId, connection, internalDomains, alreadyKnownDomains, startCursor) {
  const discovered = {};
  let nextLink = startCursor || null;
  let pagesRead = 0;
  let done = false;

  do {
    let page;
    try {
      page = await fetchSentItemsPage(env, connection, userId, nextLink);
    } catch (e) {
      break; // couldn't read this mailbox right now - stop, keep whatever cursor we had
    }
    pagesRead++;
    for (const m of page.value || []) {
      for (const to of m.toRecipients || []) {
        const email = (to.emailAddress && to.emailAddress.address || "").toLowerCase();
        const domain = domainOf(email);
        if (!domain || internalDomains.has(domain)) continue;
        if (discovered[domain] || alreadyKnownDomains.has(domain)) continue; // already have a more recent record for this domain
        discovered[domain] = {
          lastSent: m.sentDateTime,
          subject: m.subject || "",
          recipientEmail: email,
          recipientName: to.emailAddress.name || null,
          conversationId: m.conversationId || null,
        };
      }
    }
    nextLink = page["@odata.nextLink"] || null;
    if (!nextLink) done = true;
  } while (nextLink && pagesRead < MAX_PAGES_PER_MAILBOX_PER_RUN);

  return { discovered, nextCursor: nextLink, done, pagesRead };
}

// Reuses the same $search participants query fetchRecentCorrespondence
// uses, but asks a narrower question: is the MOST RECENT message with this
// person from them (a reply - exclude from bump candidates) or still from
// us (genuinely cold - a real bump candidate)? Returns null when it can't
// tell (mailbox unreadable etc.) - callers treat that as "assume still
// cold" per the same degrade-gracefully rule as everywhere else, but flag
// it as unverified rather than silently claiming certainty.
export async function hasRepliedSince(env, userId, connection, contactEmail, sinceIso) {
  const url = `${GRAPH_BASE}/me/messages?$search="participants:${encodeURIComponent(contactEmail)}"` +
    `&$top=5&$select=from,receivedDateTime,sentDateTime`;
  let body;
  try {
    body = await graphGet(env, connection, userId, url);
  } catch (e) {
    return null;
  }
  const messages = (body.value || []).slice().sort(
    (a, b) => new Date(b.receivedDateTime || b.sentDateTime) - new Date(a.receivedDateTime || a.sentDateTime)
  );
  if (!messages.length) return false;
  const latest = messages[0];
  const latestFrom = (latest.from && latest.from.emailAddress && latest.from.emailAddress.address || "").toLowerCase();
  const latestDate = latest.receivedDateTime || latest.sentDateTime;
  if (!latestDate || new Date(latestDate) <= new Date(sinceIso)) return false; // nothing newer than our own last send
  return latestFrom === contactEmail.toLowerCase();
}

export function daysSince(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000));
}

export { COLD_GAP_DAYS };
