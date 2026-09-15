import { verifySession, readCookie } from "./shared/session.js";

// Every request needs a valid signed session cookie, established by the
// Microsoft sign-in flow (src/routes/login.js -> .../callback.js). The
// auth routes themselves are always let through - they're what creates
// the session in the first place.
const PUBLIC_PATHS = new Set(["/auth/login", "/auth/callback", "/auth/logout"]);

export async function requireAuth(request, env) {
  const url = new URL(request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return null;

  const token = readCookie(request, "session");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (session) return null;

  // An API call gets a plain 401 (the page's own fetch/XHR calls can't
  // follow a redirect into an HTML sign-in page usefully); a normal page
  // load gets sent to sign in and back.
  if (url.pathname.startsWith("/api/")) {
    return new Response("Authentication required.", { status: 401 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/auth/login" },
  });
}
