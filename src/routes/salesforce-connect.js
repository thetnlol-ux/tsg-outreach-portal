import { verifySession, readCookie } from "../shared/session.js";
import { pkcePair } from "../shared/msjwt.js";
import { resolveSalesforceOrg } from "../shared/salesforceOrgs.js";

// Each person connects their own Salesforce login - there's no shared
// company-wide credential. Which org they land on is resolved from their
// own sign-in email domain, not a choice they make here.
export async function handleSalesforceConnect(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/" } });

  const org = resolveSalesforceOrg(env, session.email);
  if (!org) {
    return new Response("Salesforce isn't set up for your organisation yet.", { status: 400 });
  }

  const { verifier, challenge } = await pkcePair();
  const state = crypto.randomUUID();

  const url = new URL(`https://${org.loginDomain}/services/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", org.clientId);
  url.searchParams.set("redirect_uri", env.SALESFORCE_REDIRECT_URI);
  url.searchParams.set("scope", "api refresh_token");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers({ Location: url.toString() });
  headers.append(
    "Set-Cookie",
    `sf_pkce_verifier=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  headers.append(
    "Set-Cookie",
    `sf_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  return new Response(null, { status: 302, headers });
}
