// A single shared password gates the whole site (including the static
// assets) via HTTP Basic Auth. This is a stopgap, not real per-user login -
// unlike tsg-portal, this repo has no Microsoft/Salesforce OAuth wired up.
// Fails closed: until PORTAL_PASSWORD is set as a secret, nothing is
// served rather than the portal (and its lead data) sitting open.
export function requireAuth(request, env) {
  const configured = env.PORTAL_PASSWORD;
  if (!configured) {
    return new Response(
      "This portal is not configured yet: the PORTAL_PASSWORD secret is not set.",
      { status: 503 }
    );
  }

  const header = request.headers.get("Authorization") || "";
  const expected = "Basic " + btoa(`portal:${configured}`);
  if (header !== expected) {
    return new Response("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="TSG Outreach Portal"' },
    });
  }

  return null;
}
