// ZoomInfo's newer "gtm" API, Client Credentials OAuth flow - a single
// org-wide app (no per-person "Connect ZoomInfo" step, unlike
// Salesforce/Outlook: this is one shared company license, not individual
// logins). See https://docs.zoominfo.com/docs/client-credentials-flow.

const TOKEN_ENDPOINT = "https://api.zoominfo.com/gtm/oauth/v1/token";
const API_BASE = "https://api.zoominfo.com/gtm/data/v1";

// Cached per Worker isolate - cheap to re-fetch on a cold start, avoids a
// token round-trip on every call within one isolate's lifetime.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

  const basic = btoa(`${env.ZOOMINFO_CLIENT_ID}:${env.ZOOMINFO_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`ZoomInfo token request failed: ${await res.text()}`);
  }
  const body = await res.json();
  cachedToken = body.access_token;
  // Refresh a little early rather than right on the edge of expiry.
  cachedTokenExpiresAt = now + Math.max(0, (body.expires_in - 30)) * 1000;
  return cachedToken;
}

async function callApi(env, path, body) {
  const token = await getAccessToken(env);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ZoomInfo API ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Basic company search - name/website/etc criteria in, a short list of
// candidate companies (id, name, website, size) out. Use enrichCompany
// with the chosen companyId to get the full record.
export async function searchCompany(env, criteria, { page = 1, pageSize = 10 } = {}) {
  return callApi(
    env,
    `/companies/search?page[number]=${page}&page[size]=${pageSize}`,
    { data: { type: "CompanySearch", attributes: criteria } }
  );
}

// Full company record for up to 25 companies at once, matched by
// companyId, companyName, companyWebsite, etc (see ZoomInfo's docs for
// the full list of match fields).
export async function enrichCompany(env, matchCompanyInput, outputFields) {
  return callApi(env, "/companies/enrich", {
    data: {
      type: "CompanyEnrich",
      attributes: { matchCompanyInput, outputFields },
    },
  });
}
