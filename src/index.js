import { requireAuth } from "./auth.js";
import { handleGetState, handleSaveState } from "./state.js";

// Small router: /api/state is the only real logic here, everything else
// (index.html, and anything static added later) falls straight through to
// Cloudflare's own static asset server. Every request - API and static
// alike - is gated by the shared-password check first.
export default {
  async fetch(request, env) {
    const authFailure = requireAuth(request, env);
    if (authFailure) return authFailure;

    const url = new URL(request.url);

    if (url.pathname === "/api/state") {
      if (request.method === "GET") return handleGetState(request, env);
      if (request.method === "POST") return handleSaveState(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    return env.ASSETS.fetch(request);
  },
};
