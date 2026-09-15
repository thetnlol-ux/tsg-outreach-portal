// Maps a signed-in person's email domain to their own Salesforce org's
// connection details. Tapflo and Sychem are separate Salesforce orgs, each
// with its own dedicated Connected App (its own Consumer Key/Secret) - a
// deliberate choice to keep this portal's Salesforce access separate from
// tsg-portal's, same reasoning as the Entra app registration. Mirrors
// tsg-portal's per-company client id/secret suffix pattern, just keyed by
// email domain instead of a companies table row (this portal has none).
const ORGS = {
  "tapflopumps.co.uk": "TAPFLO",
  "sychem.co.uk": "SYCHEM",
};

export function resolveSalesforceOrg(env, email) {
  const domain = (email || "").split("@")[1] || "";
  const orgKey = ORGS[domain.toLowerCase()];
  if (!orgKey) return null;

  const loginDomain = env[`SALESFORCE_DOMAIN_${orgKey}`];
  const clientId = env[`SALESFORCE_CLIENT_ID_${orgKey}`];
  const clientSecret = env[`SALESFORCE_CLIENT_SECRET_${orgKey}`];
  if (!loginDomain || !clientId || !clientSecret) return null;

  return { orgKey, loginDomain, clientId, clientSecret };
}
