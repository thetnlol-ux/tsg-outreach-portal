import { pkcePair } from "../shared/msjwt.js";

const SCOPES = "openid profile email offline_access User.Read";

export async function handleLogin(request, env) {
  const { verifier, challenge } = await pkcePair();
  const state = crypto.randomUUID();

  const url = new URL("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", env.MS_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", env.MS_REDIRECT_URI);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Forces Microsoft to always show an account picker rather than silently
  // reusing whichever Microsoft account already has an active session in
  // this browser - avoids signing someone in as the wrong account.
  url.searchParams.set("prompt", "select_account");

  const headers = new Headers({ Location: url.toString() });
  headers.append(
    "Set-Cookie",
    `pkce_verifier=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  headers.append(
    "Set-Cookie",
    `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  return new Response(null, { status: 302, headers });
}
