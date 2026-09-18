// Live "has this contact already been emailed?" lookup, using the signed-in
// rep's own connected Outlook mailbox via Microsoft Graph. Same
// certificate-credential refresh flow as outlook-callback.js. Mirrors
// tsg-portal's proven implementation of the same feature.
import { buildClientAssertion } from "./msjwt.js";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
// Kept identical to outlook-connect.js/outlook-callback.js's SCOPES - a
// refresh has to ask for exactly what the original connection granted.
const SCOPES = "openid offline_access Mail.Read Mail.Send Calendars.Read User.Read";

export async function refreshOutlookToken(env, connection) {
  const clientAssertion = await buildClientAssertion({
    clientId: env.MS_CLIENT_ID,
    tokenEndpoint: TOKEN_ENDPOINT,
    certThumbprintHex: env.MS_CERT_THUMBPRINT,
    privateKeyPkcs8Base64: env.MS_PRIVATE_KEY_PKCS8,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      scope: SCOPES,
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    }),
  });
  if (!res.ok) throw new Error(`Outlook token refresh failed: ${await res.text()}`);
  const tokens = await res.json();
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || connection.refresh_token };
}

async function searchOneMailbox(env, userId, connection, contactEmail, limit) {
  const search = (token) =>
    fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$search="participants:${encodeURIComponent(contactEmail)}"&$top=${limit}&$select=subject,from,receivedDateTime,bodyPreview`,
      { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" } }
    );

  let res = await search(connection.access_token);
  if (res.status === 401) {
    let refreshed;
    try {
      refreshed = await refreshOutlookToken(env, connection);
    } catch (e) {
      return null;
    }
    await env.DB.prepare(
      "UPDATE outlook_connections SET access_token = ?, refresh_token = ?, updated_at = datetime('now') WHERE user_id = ?"
    )
      .bind(refreshed.accessToken, refreshed.refreshToken, userId)
      .run();
    res = await search(refreshed.accessToken);
  }

  if (!res.ok) return null; // mailbox not readable (e.g. MailboxNotEnabledForRESTAPI) - degrade, don't fail the check

  const body = await res.json();
  return (body.value || []).map((m) => ({
    from: m.from && m.from.emailAddress ? m.from.emailAddress.address : null,
    received: m.receivedDateTime || null,
    subject: m.subject || "",
    preview: m.bodyPreview || "",
  }));
}

// Returns an array of recent messages (either direction) with contactEmail,
// or null if there's nothing usable to search with - no Outlook connection
// for this rep, or the mailbox itself can't be read via Graph. Callers
// treat null the same as "no correspondence available" - never an error.
export async function fetchRecentCorrespondence(env, userId, contactEmail, limit = 15) {
  if (!contactEmail) return null;
  const connection = await env.DB.prepare(
    "SELECT access_token, refresh_token FROM outlook_connections WHERE user_id = ?"
  )
    .bind(userId)
    .first();
  if (!connection) return null;
  return searchOneMailbox(env, userId, connection, contactEmail, limit);
}

// Real sending via Graph's /me/sendMail - the "Send Email" button on
// Suggested Mailshots and the Cold Lead Action Desk. Always sends as the
// signed-in rep's own connected mailbox (never a shared/service identity),
// so it lands in their own Sent Items exactly like a hand-sent email would -
// which is what the rest of this portal already relies on for follow-up/
// mailshot dedupe. Needs the Mail.Send scope (see SCOPES above); a
// connection made before this was added won't have it and has to be
// reconnected once. Throws on failure rather than degrading, unlike the
// read-only helpers below - this is an explicit user action that needs to
// report success or failure honestly, not a best-effort background check.
export async function sendOutlookMail(env, userId, connection, { to, subject, body, contentType = "HTML" }) {
  const payload = {
    message: {
      subject,
      body: { contentType, content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };
  const send = (token) =>
    fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  let res = await send(connection.access_token);
  if (res.status === 401) {
    const refreshed = await refreshOutlookToken(env, connection);
    await env.DB.prepare(
      "UPDATE outlook_connections SET access_token = ?, refresh_token = ?, updated_at = datetime('now') WHERE user_id = ?"
    )
      .bind(refreshed.accessToken, refreshed.refreshToken, userId)
      .run();
    res = await send(refreshed.accessToken);
  }
  if (!res.ok) {
    throw new Error(`Outlook send failed (${res.status}): ${await res.text()}`);
  }
}

// The "Sent Items, across Aidan, Jay and Beth" dedupe gate from the real
// sourcing methodology (see zoominfo-source-leads.js) - checks every
// mailbox that's actually connected via Outlook right now, not just the
// signed-in rep's own. Whoever hasn't connected simply isn't covered - this
// returns which emails/user ids were actually checked alongside the
// results, so callers can say plainly "checked Aidan + Jay, not Beth"
// rather than imply full coverage that was never real.
export async function fetchCorrespondenceAcrossConnectedMailboxes(env, contactEmail, limit = 10) {
  if (!contactEmail) return { checkedMailboxes: [], matches: [] };
  const rows = await env.DB.prepare(
    `SELECT oc.user_id, oc.access_token, oc.refresh_token, u.email, u.display_name
     FROM outlook_connections oc JOIN users u ON u.id = oc.user_id`
  ).all();

  const checkedMailboxes = [];
  const matches = [];
  for (const row of rows.results || []) {
    checkedMailboxes.push(row.email);
    let messages;
    try {
      messages = await searchOneMailbox(
        env, row.user_id,
        { access_token: row.access_token, refresh_token: row.refresh_token },
        contactEmail, limit
      );
    } catch (e) {
      messages = null;
    }
    if (messages && messages.length) {
      matches.push({ mailbox: row.email, displayName: row.display_name, messages });
    }
  }
  return { checkedMailboxes, matches };
}
