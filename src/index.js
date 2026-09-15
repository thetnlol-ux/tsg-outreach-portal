import { requireAuth } from "./auth.js";
import { handleGetState, handleSaveState } from "./state.js";
import { handleLogin } from "./routes/login.js";
import { handleCallback } from "./routes/callback.js";
import { handleLogout } from "./routes/logout.js";
import { handleSalesforceConnect } from "./routes/salesforce-connect.js";
import { handleSalesforceCallback } from "./routes/salesforce-callback.js";
import { handleOutlookConnect } from "./routes/outlook-connect.js";
import { handleOutlookCallback } from "./routes/outlook-callback.js";
import { handleDisconnectSalesforce, handleDisconnectOutlook } from "./routes/disconnect.js";
import { verifySession, readCookie } from "./shared/session.js";

// Small router: /auth/*, /connect/* and /api/* are the only real logic
// here. Everything else - "/" (the public landing page), "/dashboard"
// (Cloudflare serves public/dashboard.html for this automatically - its
// own clean-URL handling, no rewrite needed here) - falls straight
// through to Cloudflare's own static asset server. Every request is
// gated by the signed-in-session check first, except "/" and the auth
// routes themselves (they're what establishes it).
//
// Do NOT special-case "/dashboard" here to fetch "/dashboard.html"
// explicitly - Cloudflare's asset server treats that .html URL as a
// non-canonical alias of "/dashboard" and 307-redirects it back to
// "/dashboard", which this router was also intercepting, producing an
// infinite redirect loop (confirmed for real - see git history for the
// exact reproduction).
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
      const [sf, ol] = await Promise.all([
        env.DB.prepare("SELECT 1 FROM salesforce_connections WHERE user_id = ?").bind(session.userId).first(),
        env.DB.prepare("SELECT 1 FROM outlook_connections WHERE user_id = ?").bind(session.userId).first(),
      ]);
      return new Response(
        JSON.stringify({
          email: session.email,
          displayName: session.displayName,
          salesforceConnected: !!sf,
          outlookConnected: !!ol,
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    return env.ASSETS.fetch(request);
  },
};
