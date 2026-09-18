import { verifySession, readCookie } from "../shared/session.js";
import { pkcePair } from "../shared/msjwt.js";

// Separate from the "Sign in with Microsoft" flow in login.js. Signing in
// just proves who someone is; this step is the person choosing to let the
// portal read their own mailbox too. Same Microsoft app registration,
// wider scopes, its own redirect address so the two flows don't get
// confused with each other.
// 18 Sep: added Mail.Send for real sending from Suggested Mailshots/the Cold
// Lead Action Desk (see sendOutlookMail in outlookMail.js) - anyone already
// connected needs to reconnect once to grant it; Graph won't hand out a
// token for a scope it was never asked for, refresh included.
const SCOPES = "openid offline_access Mail.Read Mail.Send Calendars.Read User.Read";

export async function handleOutlookConnect(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/" } });

  const { verifier, challenge } = await pkcePair();
  const state = crypto.randomUUID();

  const url = new URL("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", env.MS_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", env.MS_OUTLOOK_REDIRECT_URI);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // select_account alone isn't reliable proof of which account gets
  // connected on a work device (a Primary Refresh Token can silently
  // complete the login as whichever account the device itself trusts,
  // regardless of which tile is clicked) - prompt=login forces a genuine
  // fresh sign-in, confirmed for real as the fix on tsg-portal.
  url.searchParams.set("prompt", "login");

  const headers = new Headers({ Location: url.toString() });
  headers.append(
    "Set-Cookie",
    `ol_pkce_verifier=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  headers.append(
    "Set-Cookie",
    `ol_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  return new Response(null, { status: 302, headers });
}
