// Talks to a person's own Salesforce org using their stored refresh token.
// Every export here takes the `org` (from resolveSalesforceOrg) and the row
// from `salesforce_connections` explicitly, rather than looking them up
// itself, so callers stay in control of exactly whose data is touched.

async function refreshAccessToken(env, org, connection) {
  const res = await fetch(`https://${org.loginDomain}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
      client_id: org.clientId,
      client_secret: org.clientSecret,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Salesforce token refresh failed: ${detail}`);
  }
  const tokens = await res.json();
  return { accessToken: tokens.access_token, instanceUrl: tokens.instance_url || connection.instance_url };
}

// Runs one SOQL query, refreshing the stored access token if Salesforce
// rejects the current one, and persisting the new access token so the next
// call doesn't need to refresh again. Automatically follows nextRecordsUrl
// so callers always get every row, capped at a sane limit so a runaway
// query can't hang the request.
export async function runSoql(env, org, connection, userId, soql) {
  let accessToken = connection.access_token;
  let instanceUrl = connection.instance_url;

  const doQuery = (url) => fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  let queryUrl = `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  let res = await doQuery(queryUrl);

  if (res.status === 401) {
    const refreshed = await refreshAccessToken(env, org, connection);
    accessToken = refreshed.accessToken;
    instanceUrl = refreshed.instanceUrl;
    await env.DB.prepare(
      "UPDATE salesforce_connections SET access_token = ?, instance_url = ?, updated_at = datetime('now') WHERE user_id = ?"
    )
      .bind(accessToken, instanceUrl, userId)
      .run();
    queryUrl = `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
    res = await doQuery(queryUrl);
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Salesforce query failed: ${detail}`);
  }

  let body = await res.json();
  const records = [...body.records];
  const MAX_PAGES = 20;
  let pages = 1;
  while (body.nextRecordsUrl && pages < MAX_PAGES) {
    const pageRes = await doQuery(`${instanceUrl}${body.nextRecordsUrl}`);
    if (!pageRes.ok) break;
    body = await pageRes.json();
    records.push(...body.records);
    pages++;
  }
  return records;
}
