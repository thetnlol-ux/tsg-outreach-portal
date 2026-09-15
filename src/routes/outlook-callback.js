import { buildClientAssertion, decodeJwtPayload } from "../shared/msjwt.js";
import { verifySession, readCookie } from "../shared/session.js";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const SCOPES = "openid offline_access Mail.Read Calendars.Read User.Read";

export async function handleOutlookCallback(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/" } });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return new Response(
      `Outlook connection failed: ${url.searchParams.get("error_description") || oauthError}`,
      { status: 400 }
    );
  }

  const expectedState = readCookie(request, "ol_oauth_state");
  const verifier = readCookie(request, "ol_pkce_verifier");
  if (!code || !state || state !== expectedState || !verifier) {
    return new Response("Outlook connection request could not be verified. Please try again.", {
      status: 400,
    });
  }

  const clientAssertion = await buildClientAssertion({
    clientId: env.MS_CLIENT_ID,
    tokenEndpoint: TOKEN_ENDPOINT,
    certThumbprintHex: env.MS_CERT_THUMBPRINT,
    privateKeyPkcs8Base64: env.MS_PRIVATE_KEY_PKCS8,
  });

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      scope: SCOPES,
      code,
      redirect_uri: env.MS_OUTLOOK_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return new Response(`Outlook connection failed: ${detail}`, { status: 400 });
  }

  const tokens = await tokenRes.json();
  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
  const msUserId = claims.oid || null;

  // Confirmed as a real failure mode on tsg-portal: Microsoft's account
  // picker isn't reliable proof of which account actually authenticated -
  // a work device can silently reuse a different trusted identity
  // regardless of which tile is clicked - so this checks the real result.
  const connectedEmail = (claims.preferred_username || claims.email || "").toLowerCase();
  if (connectedEmail && connectedEmail !== session.email.toLowerCase()) {
    return new Response(
      `Outlook connection failed: you're signed into this portal as ${session.email}, but the Microsoft account you just authenticated with was ${connectedEmail}. Please try again and make sure you sign in with ${session.email} specifically when prompted.`,
      { status: 400 }
    );
  }

  await env.DB.prepare(
    `INSERT INTO outlook_connections (user_id, refresh_token, access_token, ms_user_id, connected_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       access_token = excluded.access_token,
       ms_user_id = excluded.ms_user_id,
       updated_at = datetime('now')`
  )
    .bind(session.userId, tokens.refresh_token, tokens.access_token, msUserId)
    .run();

  await env.DB.prepare("INSERT INTO activity_log (user_id, event) VALUES (?, 'outlook_connected')")
    .bind(session.userId)
    .run();

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", "ol_pkce_verifier=; Path=/; Max-Age=0");
  headers.append("Set-Cookie", "ol_oauth_state=; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
