import { requireAuth } from "./auth.js";
import { handleGetState, handleSaveState } from "./state.js";
import { handleLogin } from "./routes/login.js";
import { handleCallback } from "./routes/callback.js";
import { handleLogout } from "./routes/logout.js";
import { handleDashboard } from "./routes/dashboard.js";
import { handleSalesforceConnect } from "./routes/salesforce-connect.js";
import { handleSalesforceCallback } from "./routes/salesforce-callback.js";
import { handleOutlookConnect } from "./routes/outlook-connect.js";
import { handleOutlookCallback } from "./routes/outlook-callback.js";
import { handleDisconnectSalesforce, handleDisconnectOutlook } from "./routes/disconnect.js";
import { verifySession, readCookie } from "./shared/session.js";

// Small router: /auth/*, /connect/*, /dashboard and /api/* are the only
// real logic here. "/" (the public landing page) and "/app" (the actual
// outreach desk, public/app.html) fall straight through to Cloudflare's
// own static asset server - no rewriting, since an explicit
// fetch-a-different-.html-path trick here previously caused a real
// infinite redirect loop (Cloudflare's asset server treats the .html URL
// as a non-canonical alias and redirects it right back). Every request
// is gated by the signed-in-session check first, except "/" and the auth
// routes themselves (they're what establishes it).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/auth/login":
        return handleLogin(request, env);
      case "/auth/callback":
        return handleCallback(request, env);
      case "/auth/logout":
        return handleLogout();
    }

    const authFailure = await requireAuth(request, env);
    if (authFailure) return authFailure;

    switch (url.pathname) {
      case "/dashboard":
        return handleDashboard(request, env);
      case "/connect/salesforce":
        return handleSalesforceConnect(request, env);
      case "/connect/salesforce/callback":
        return handleSalesforceCallback(request, env);
      case "/connect/salesforce/disconnect":
        return handleDisconnectSalesforce(request, env);
      case "/connect/outlook":
        return handleOutlookConnect(request, env);
      case "/connect/outlook/callback":
        return handleOutlookCallback(request, env);
      case "/connect/outlook/disconnect":
        return handleDisconnectOutlook(request, env);
    }

    if (url.pathname === "/api/state") {
      if (request.method === "GET") return handleGetState(request, env);
      if (request.method === "POST") return handleSaveState(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/me") {
      const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
      if (!session) {
        return new Response(JSON.stringify(null), { headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ email: session.email, displayName: session.displayName }),
        { headers: { "content-type": "application/json" } }
      );
    }

    return env.ASSETS.fetch(request);
  },
};
