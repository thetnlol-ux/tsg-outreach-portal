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
      // The data API is JSON:API - plain "application/json" gets a 406
      // Not Acceptable (confirmed for real testing directly against it).
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
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
//
// Deliberately doesn't send page[number]/page[size] as query params -
// confirmed for real that Cloudflare Workers' fetch() sends those
// brackets in a way ZoomInfo's gateway rejects outright with a generic
// 400 (curl sending the identical-looking URL works fine, so this is a
// Workers-fetch-specific encoding quirk, not a ZoomInfo API problem).
// ZoomInfo's own default page size (25) is already more than pageSize
// ever needs, so this just takes the first N of that instead.
export async function searchCompany(env, criteria, { pageSize = 10 } = {}) {
  const result = await callApi(env, "/companies/search", {
    data: { type: "CompanySearch", attributes: criteria },
  });
  return { ...result, data: (result.data || []).slice(0, pageSize) };
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
