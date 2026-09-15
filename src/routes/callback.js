import { buildClientAssertion, decodeJwtPayload } from "../shared/msjwt.js";
import { createSession, readCookie } from "../shared/session.js";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";

function allowedDomains(env) {
  return (env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return new Response(
      `Sign-in was cancelled or failed: ${url.searchParams.get("error_description") || oauthError}`,
      { status: 400 }
    );
  }

  const expectedState = readCookie(request, "oauth_state");
  const verifier = readCookie(request, "pkce_verifier");
  if (!code || !state || state !== expectedState || !verifier) {
    return new Response("Sign-in request could not be verified. Please try again.", { status: 400 });
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
      scope: "openid profile email offline_access User.Read",
      code,
      redirect_uri: env.MS_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return new Response(`Microsoft sign-in failed: ${detail}`, { status: 400 });
  }

  const tokens = await tokenRes.json();
  const claims = decodeJwtPayload(tokens.id_token);
  const email = (claims.preferred_username || claims.email || "").toLowerCase();
  const displayName = claims.name || email;
  const emailDomain = email.split("@")[1] || "";
  const oid = claims.oid;

  const allowed = allowedDomains(env);
  if (allowed.length && !allowed.includes(emailDomain)) {
    return new Response(
      `${email} isn't on an allowed domain for this portal (allowed: ${allowed.join(", ")}). ` +
        `If this is unexpected, contact your TS Group administrator.`,
      { status: 403 }
    );
  }

  // Salesforce/Outlook connections (added once this portal linked those
  // APIs) key off a stable numeric user id rather than email, so this
  // upserts a `users` row the same way tsg-portal's callback does.
  let user = await env.DB.prepare("SELECT id FROM users WHERE ms_oid = ?").bind(oid).first();
  if (!user) {
    await env.DB.prepare(
      "INSERT INTO users (ms_oid, email, display_name, created_at, last_login_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
    )
      .bind(oid, email, displayName)
      .run();
    user = await env.DB.prepare("SELECT id FROM users WHERE ms_oid = ?").bind(oid).first();
  } else {
    await env.DB.prepare(
      "UPDATE users SET last_login_at = datetime('now'), email = ?, display_name = ? WHERE id = ?"
    )
      .bind(email, displayName, user.id)
      .run();
  }

  const session = await createSession({ userId: user.id, email, displayName }, env.SESSION_SECRET);

  const headers = new Headers({ Location: "/dashboard" });
  headers.append("Set-Cookie", `session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`);
  headers.append("Set-Cookie", "pkce_verifier=; Path=/; Max-Age=0");
  headers.append("Set-Cookie", "oauth_state=; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
