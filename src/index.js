import { requireAuth } from "./auth.js";
import { handleGetState, handleSaveState } from "./state.js";
import { handleLogin } from "./routes/login.js";
import { handleCallback } from "./routes/callback.js";
import { handleLogout } from "./routes/logout.js";
import { handleDashboard } from "./routes/dashboard.js";
import { handleAdmin } from "./routes/admin.js";
import { handleZoomInfoCheckCompany } from "./routes/zoominfo-check-company.js";
import { handleSalesforceConnect } from "./routes/salesforce-connect.js";
import { handleSalesforceCallback } from "./routes/salesforce-callback.js";
import { handleOutlookConnect } from "./routes/outlook-connect.js";
import { handleOutlookCallback } from "./routes/outlook-callback.js";
import { handleDisconnectSalesforce, handleDisconnectOutlook } from "./routes/disconnect.js";
import { handleSalesforceCheckAccount } from "./routes/salesforce-check-account.js";
import { handleOutlookCheckContact } from "./routes/outlook-check-contact.js";
import { handleOutlookSend } from "./routes/outlook-send.js";
import { handleZoomInfoSourceLeads } from "./routes/zoominfo-source-leads.js";
import { handleLeadForensicsSync, runLeadForensicsSync } from "./routes/leadforensics-sync.js";
import { handleGetLeadForensicsVisits } from "./routes/leadforensics-visits.js";
import { handleMailshotSync, runMailshotSync } from "./routes/mailshot-sync.js";
import { handleGetMailshotCandidates } from "./routes/mailshot-candidates.js";
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
      case "/admin":
        return handleAdmin(request, env);
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

    if (url.pathname === "/api/salesforce/check-account") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleSalesforceCheckAccount(request, env);
    }

    if (url.pathname === "/api/zoominfo/check-company") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleZoomInfoCheckCompany(request, env);
    }

    if (url.pathname === "/api/outlook/check-contact") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleOutlookCheckContact(request, env);
    }

    if (url.pathname === "/api/outlook/send") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleOutlookSend(request, env);
    }

    if (url.pathname === "/api/zoominfo/source-leads") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleZoomInfoSourceLeads(request, env);
    }

    if (url.pathname === "/api/leadforensics/sync") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleLeadForensicsSync(request, env);
    }

    if (url.pathname === "/api/leadforensics/visits") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return handleGetLeadForensicsVisits(request, env);
    }

    if (url.pathname === "/api/mailshot/sync") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleMailshotSync(request, env);
    }

    if (url.pathname === "/api/mailshot/candidates") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return handleGetMailshotCandidates(request, env);
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

  // The "real time" half of the Lead Forensics sync and the Suggested
  // Mailshots sync (see src/shared/leadForensics.js and
  // src/routes/mailshot-sync.js) - both replace a hand-pulled snapshot
  // with a live one. Runs with no signed-in user (there isn't one on a
  // cron trigger) and no real Request, so mailshot sync gets a fixed base
  // URL to resolve its own app.html against rather than one derived from
  // a request. See wrangler.jsonc for the schedule.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runLeadForensicsSync(env));
    ctx.waitUntil(runMailshotSync(env, "https://outreach.tsgroup.cloud/"));
  },
};
