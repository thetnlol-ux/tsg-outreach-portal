# TSG Outreach Portal

Tapflo/Sychem cold-lead outreach dashboard — mailshot tracking, follow-up
stages, call logging, rep performance. Originally a single-user Claude.ai
artifact; this repo is that same dashboard moved to its own Cloudflare
Worker so it works as a real site, independent of Claude.ai.

Separate from, and does not touch, the `tsg-portal` repo/Worker/database.

## How it's put together

- `public/index.html` — the dashboard itself. Mostly unchanged from the
  original artifact; the one functional change is how it saves edits (see
  below).
- `src/index.js` — the Worker: a tiny router for `/api/state`, everything
  else falls through to the static `public/` files.
- `src/state.js` — reads/writes the portal's editable state (leads,
  mailshot-sent flags, never-contact list) as one JSON blob in D1, with
  optimistic-concurrency version checks.
- `src/auth.js` — a single shared password (HTTP Basic Auth) gating the
  whole site. Not real per-user login — see **Known limitations** below.
- `migrations/0001_init.sql` — the one D1 table this needs. Already applied
  to the `tsg-outreach-portal-db` database created for this project.

## What changed from the original artifact

The original saved edits (call notes, mailshot-sent flags, opt-outs) by
calling `window.claude.use('artifact')` and rewriting its own published
source — that only works inside a Claude.ai artifact viewer. Here, the
same save action instead does a plain `fetch('/api/state', {method:
'POST', ...})` against this Worker, which persists it to D1. On page load,
the page fetches `/api/state` and uses whatever's there in place of the
data baked into the file at deploy time, so edits made on the live site
survive a refresh and are visible to the next person, not just the person
who made them.

Everything else — the layout, the scoring, the mailshot templates, the
lead data itself — is untouched.

## Known limitations / what's still manual

- **Auth is a single shared password**, not the real Microsoft login
  `tsg-portal` has. Anyone with the password can see and edit all lead
  data. Set the `PORTAL_PASSWORD` secret before treating this as live —
  the site 401s on every request until it's set.
- **"Refresh leads" and lead enrichment are still a manual, Claude-in-the-
  loop workflow.** The board's refresh button copies a prompt to the
  clipboard for pasting into a separate Claude chat that has Salesforce/
  Outlook/ZoomInfo connectors — there's no code here doing live enrichment.
  That prompt's final instruction now tells you to bring the result back
  to this repo (paste the updated `tapfloLeads`/`sychemLeads`/
  `MAILSHOT_SENT`/`NEVER_CONTACT` into the portal, or hand it to Claude
  Code) instead of publishing to a Claude.ai artifact, since that no
  longer exists for this dashboard.

## Deploying (one-time setup, in the Cloudflare dashboard)

Deploys the same way `tsg-portal` does — connect this repo to Cloudflare
Workers so it builds and deploys on every push:

1. Cloudflare dashboard → Workers & Pages → **Create** → **Import a
   repository**, pick `thetnlol-ux/tsg-outreach-portal`.
2. Once created, Settings → **Variables and Secrets** → add `PORTAL_PASSWORD`
   as an encrypted secret (the shared password for the whole site).
3. Settings → **Domains & Routes** → add the custom domain
   `outreach.tsgroup.cloud` (already declared in `wrangler.jsonc`, but
   Cloudflare Custom Domains sometimes need adding once by hand the first
   time — if the route in `wrangler.jsonc` already claimed it on first
   deploy, this step is a no-op).

The D1 database (`tsg-outreach-portal-db`) and its one table already exist
and are wired into `wrangler.jsonc` — nothing to do there.
