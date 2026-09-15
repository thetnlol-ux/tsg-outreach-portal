import { verifySession, readCookie } from "./shared/session.js";

// "/" is the public landing page (a branded card with a "Sign in with
// Microsoft" button, same pattern as tsg-portal) - everything else needs
// a valid signed session cookie, established by the Microsoft sign-in
// flow (src/routes/login.js -> .../callback.js). The auth routes
// themselves are always let through too - they're what creates it.
const PUBLIC_PATHS = new Set(["/", "/auth/login", "/auth/callback", "/auth/logout"]);

export async function requireAuth(request, env) {
  const url = new URL(request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return null;

  const token = readCookie(request, "session");
  const session = await verifySession(token, env.SESSION_SECRET);
  // A cookie signed before a field was added to the session payload (e.g.
  // userId, added once Salesforce/Outlook connections needed one) still
  // verifies fine - it's just missing that field. Treating that as
  // unauthenticated forces one automatic re-login instead of silently
  // breaking whatever depends on the new field.
  if (session && session.userId) return null;

  // An API call gets a plain 401 (the page's own fetch/XHR calls can't
  // follow a redirect into an HTML sign-in page usefully); a normal page
  // load gets sent back to the landing page to sign in properly, same as
  // tsg-portal's dashboard route does.
  if (url.pathname.startsWith("/api/")) {
    return new Response("Authentication required.", { status: 401 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/" },
  });
}
