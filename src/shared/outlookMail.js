// Live "has this contact already been emailed?" lookup, using the signed-in
// rep's own connected Outlook mailbox via Microsoft Graph. Same
// certificate-credential refresh flow as outlook-callback.js. Mirrors
// tsg-portal's proven implementation of the same feature.
import { buildClientAssertion } from "./msjwt.js";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const SCOPES = "openid offline_access Mail.Read Calendars.Read User.Read";

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
