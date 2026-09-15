import { requireAuth } from "./auth.js";
import { handleGetState, handleSaveState } from "./state.js";
import { handleLogin } from "./routes/login.js";
import { handleCallback } from "./routes/callback.js";
import { handleLogout } from "./routes/logout.js";
import { verifySession, readCookie } from "./shared/session.js";

// Small router: /auth/* and /api/state are the only real logic here,
// everything else (index.html, and anything static added later) falls
// straight through to Cloudflare's own static asset server. Every request
// - API and static alike - is gated by the signed-in-session check first,
// except the auth routes themselves (they're what establishes it).
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

    if (url.pathname === "/api/state") {
      if (request.method === "GET") return handleGetState(request, env);
      if (request.method === "POST") return handleSaveState(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/me") {
      const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
      return new Response(JSON.stringify(session ? { email: session.email, displayName: session.displayName } : null), {
        headers: { "content-type": "application/json" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
