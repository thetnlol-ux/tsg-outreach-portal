import { verifySession, readCookie } from "../shared/session.js";
import { resolveSalesforceOrg } from "../shared/salesforceOrgs.js";

export async function handleSalesforceCallback(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/" } });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return new Response(
      `Salesforce connection failed: ${url.searchParams.get("error_description") || oauthError}`,
      { status: 400 }
    );
  }

  const expectedState = readCookie(request, "sf_oauth_state");
  const verifier = readCookie(request, "sf_pkce_verifier");
  if (!code || !state || state !== expectedState || !verifier) {
    return new Response("Salesforce connection request could not be verified. Please try again.", {
      status: 400,
    });
  }

  const org = resolveSalesforceOrg(env, session.email);
  if (!org) {
    return new Response("Salesforce isn't set up for your organisation yet.", { status: 400 });
  }

  const tokenRes = await fetch(`https://${org.loginDomain}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: org.clientId,
      client_secret: org.clientSecret,
      redirect_uri: env.SALESFORCE_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return new Response(`Salesforce connection failed: ${detail}`, { status: 400 });
  }

  const tokens = await tokenRes.json();

  // A rep's Salesforce login email can genuinely differ from the email
  // they sign into this portal with via Microsoft - fetched here up front
  // so any future Owner.Email query uses Salesforce's own idea of it.
  let salesforceEmail = null;
  try {
    const identityRes = await fetch(`${tokens.instance_url}/services/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (identityRes.ok) {
      const identity = await identityRes.json();
      salesforceEmail = identity.email || null;
    }
  } catch (e) {
    /* left null - not required for the connection itself */
  }

  await env.DB.prepare(
    `INSERT INTO salesforce_connections (user_id, org_key, instance_url, refresh_token, access_token, salesforce_user_id, salesforce_email, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       org_key = excluded.org_key,
       instance_url = excluded.instance_url,
       refresh_token = excluded.refresh_token,
       access_token = excluded.access_token,
       salesforce_user_id = excluded.salesforce_user_id,
       salesforce_email = excluded.salesforce_email,
       updated_at = datetime('now')`
  )
    .bind(session.userId, org.orgKey, tokens.instance_url, tokens.refresh_token, tokens.access_token, tokens.id || null, salesforceEmail)
    .run();

  await env.DB.prepare("INSERT INTO activity_log (user_id, event) VALUES (?, 'salesforce_connected')")
    .bind(session.userId)
    .run();

  const headers = new Headers({ Location: "/dashboard" });
  headers.append("Set-Cookie", "sf_pkce_verifier=; Path=/; Max-Age=0");
  headers.append("Set-Cookie", "sf_oauth_state=; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
