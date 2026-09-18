# TSG Outreach Portal

Tapflo/Sychem cold-lead outreach dashboard — mailshot tracking, follow-up
stages, call logging, rep performance. Originally a single-user Claude.ai
artifact; this repo is that same dashboard moved to its own Cloudflare
Worker so it works as a real site, independent of Claude.ai.

Separate from, and does not touch, the `tsg-portal` repo/Worker/database.

## How it's put together

- `public/index.html` — the public landing page ("Sign in with Microsoft"),
  same pattern as `tsg-portal`'s.
- `src/routes/dashboard.js` — server-rendered hub page at `/dashboard`,
  shown right after signing in: Connect/Disconnect status for Salesforce
  and Outlook, plus a button into the actual app. Same card design as
  `tsg-portal`'s own `/dashboard`.
- `public/app.html` — the outreach desk itself (mailshot tracking,
  follow-up stages, call logging, rep performance), served at `/app`.
  Mostly unchanged from the original artifact; the one functional change
  is how it saves edits (see below).
- `src/index.js` — the Worker: a tiny router for `/dashboard`, `/auth/*`,
  `/connect/*` and `/api/*`; everything else ("/" and "/app") falls
  through to the static `public/` files as-is.
- `src/state.js` — reads/writes the portal's editable state (leads,
  mailshot-sent flags, never-contact list) as one JSON blob in D1, with
  optimistic-concurrency version checks.
- `src/auth.js` — gates every request behind a signed session cookie.
- `src/routes/login.js`, `callback.js`, `logout.js`, `src/shared/msjwt.js`,
  `src/shared/session.js` — Microsoft sign-in (Entra ID), same
  certificate-credential pattern `tsg-portal` uses, against a dedicated
  app registration (`TSG Outreach Portal`, not `tsg-portal`'s app).
  Anyone signing in with a `@tapflopumps.co.uk` or `@sychem.co.uk`
  Microsoft account gets in — see `ALLOWED_EMAIL_DOMAINS` in
  `wrangler.jsonc`. No separate users/companies table; this portal is one
  shared board for both companies' reps, not per-company data isolation.
- `src/routes/salesforce-connect.js`, `salesforce-callback.js`,
  `src/shared/salesforce.js`, `salesforceOrgs.js` — per-person "Connect
  Salesforce", same OAuth2 + PKCE pattern `tsg-portal` uses. Tapflo and
  Sychem are separate Salesforce orgs with their own dedicated Connected
  Apps (not `tsg-portal`'s); which one a person lands on is resolved from
  their sign-in email domain, not a choice they make.
- `src/routes/outlook-connect.js`, `outlook-callback.js` — per-person
  "Connect Outlook", reusing the same Entra app and certificate as sign-in
  (wider scopes, its own redirect address).
- `src/routes/admin.js` — the Control Centre at `/admin`: every user,
  whether they've connected Salesforce/Outlook, and recent activity. Same
  oversight idea as `tsg-portal`'s `/admin`, but access is a plain email
  allowlist (`ADMIN_EMAILS` in `wrangler.jsonc`) rather than a role
  column, since this portal has no users/roles table. Admins get a
  "Control Centre" link on `/dashboard`.
- `src/routes/disconnect.js` — lets a person redo either connection from
  scratch if it ends up pointing at the wrong account.
- `src/routes/salesforce-check-account.js`, `zoominfo-check-company.js`,
  `outlook-check-contact.js`, `src/shared/zoominfo.js`,
  `src/shared/outlookMail.js` — the three live checks on the outreach desk
  (`/api/salesforce/check-account`, `/api/zoominfo/check-company`,
  `/api/outlook/check-contact`): "Check Salesforce" and "Check ZoomInfo"
  are per-lead (a company-level dedupe/enrichment query), "Check Outlook"
  is per-contact (searches the signed-in rep's own connected mailbox for
  prior correspondence with that specific person). All three return
  candidate matches for a human to judge — never a silent yes/no.
- `src/routes/zoominfo-source-leads.js` (`/api/zoominfo/source-leads`) —
  Tapflo's "top the desk back up to 50 whenever it drops below 10" rule.
  Rewritten 18 Sep to follow the real sourcing methodology a colleague
  wrote up from the actual 213-lead/453-contact board, rather than the
  ad-hoc first version. A "Source more leads" button appears on the
  Tapflo column once it's below 10; clicking it runs the same shape as a
  real refresh:
  - **Sector-targeted, not open-ended.** The board is already over target
    on food & drink (62% vs a 55% target), so this only searches chemical
    manufacturing, industrial, and waste/effluent/environmental — the
    three sectors currently under their target share — one bare
    ZoomInfo `industryKeywords` term per call (confirmed unreliable
    combined).
  - **Four dedupe gates**: Salesforce Accounts by name, Salesforce
    Contacts by email/domain, the board itself, and Sent Items across
    every *connected* mailbox (Aidan and Jay right now — Beth has never
    signed into the portal, so her mailbox can't be checked; each
    candidate says plainly which mailboxes were actually covered). Gate 4
    is a simplified version of the real one — it drops an already-emailed
    contact rather than classifying it into active/excluded/startable the
    way a full refresh does.
  - **"No email, no lead"**: a contact search can return real people, but
    if nobody survives with a real email, the company isn't sourced at
    all — never with a weak contact as filler.
  - **"No mobiles" is the real rule** (business email + direct dial +
    switchboard) but this ZoomInfo plan disallows requesting `directPhone`
    on contact enrichment outright (a genuine "contact your Account
    Manager" rejection) — mobile is used as a flagged fallback instead,
    noted honestly on every contact rather than pretending the real rule
    was followed.
  - **Scoring genuinely varies now**: job role match (core vs secondary
    title for the sector), industry/application fit (fixed per sector,
    reflecting how directly that sector's real duties match Tapflo's
    product range per the methodology), a real news/funding check against
    ZoomInfo's Scoops endpoint (most companies still score 0 — confirmed
    for real, only a minority of UK SMEs have any Scoops coverage at all),
    and customer-profile match (similarity to that sector's real end-user
    closed-won base, not a restatement of the Salesforce dedupe outcome).
  Worth knowing: unlike the free checks above, this **spends real
  ZoomInfo credits** — contact enrichment (`/contacts/enrich`) is a paid,
  per-contact call, capped at 15 new candidates per click regardless of
  how many are actually missing; the real methodology's own numbers (a
  ~10% hit rate sourcing this sector mix) mean hitting "need" in full
  takes several clicks, not one. Tapflo only — Sychem's
  Salesforce dedupe has a known licensing gap and its own targeting
  criteria (quality/technical/decontamination roles) haven't been set up.
- `migrations/0001_init.sql`, `0002_connections.sql`, `0003_leadforensics.sql`
  — the D1 tables this needs (`portal_state`; `users`/
  `salesforce_connections`/`outlook_connections`/`activity_log` for the API
  connections; `leadforensics_cache` for the sync below). Already applied
  to the `tsg-outreach-portal-db` database created for this project.
- `src/shared/leadForensics.js`, `src/routes/leadforensics-sync.js`,
  `leadforensics-visits.js` (`/api/leadforensics/sync`, `/api/
  leadforensics/visits`) — replaces the hand-pulled `LF_VISITS` snapshot
  in `app.html` (dated 17 Sep) with a live sync, per Aidan's own note that
  "when this portal is on our server it will pull this information in
  real time." Lead Forensics' API only goes one direction — "who visited
  the site in this date range" (paginated, no name/domain filter) — never
  "did company X visit" on demand, confirmed against their real API
  (`GetBusiness` only takes a numeric ID). So this pages through every
  recent site visitor (confirmed working at `pagesize=1000` — ~90 days of
  Tapflo's traffic is ~5,900 businesses, so ~6 calls) and matches by
  domain against the board, the same shape as the original hand sweep.
  Runs automatically every 6 hours via a Cloudflare Cron Trigger (see
  `scheduled()` in `src/index.js` and `triggers.crons` in
  `wrangler.jsonc`), well inside their 1000-calls/day limit, or on demand
  via the "Sync Lead Forensics" button. Needs `LEADFORENSICS_CLIENT_ID`
  (a plain var, already in `wrangler.jsonc`) and `LEADFORENSICS_API_KEY`
  (a secret — add it via the Cloudflare dashboard, same as
  `ZOOMINFO_CLIENT_SECRET`) before it'll do anything; without it, the
  route reports `not_configured` rather than failing silently.

  **Known real-world constraint, confirmed on the first live run against
  the actual board:** Cloudflare caps subrequests (`fetch()` calls) per
  Worker invocation at 50. A full sync's cheap pagination scan is only
  ~6-10 calls, but this board matched 152 unique domains on its first
  run (far more than the original hand sweep's "2 of 241", because that
  sweep only checked cold leads while this checks every contact across
  both brands - a known customer's engineer researching a spec is a real
  signal too) — checking all of them would need ~300 more calls, way
  over the cap. So each run only fetches visit detail for a capped batch
  (`MAX_DETAIL_LOOKUPS_PER_RUN` in `leadForensics.js`, currently 18),
  prioritising whichever matched domains haven't been checked yet or
  were checked longest ago, and merges those results into whatever's
  already cached rather than replacing it wholesale. Full coverage of a
  large match set takes several runs (a few cron cycles, or a few clicks
  of "Sync" in a row) rather than one — the button's status text says
  how many are left to check.

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

- **"Refresh leads" and lead scoring/drafting are still a manual, Claude-
  in-the-loop workflow.** The board's refresh button copies a prompt to
  the clipboard for pasting into a separate Claude chat — there's no code
  here doing that end-to-end automatically yet. The three live checks
  ("Check Salesforce", "Check ZoomInfo", "Check Outlook" — see above) are
  real, working, on-demand queries against each rep's own connections;
  fully automating "Refresh leads" itself (scoring new leads, drafting
  outreach) would need the Claude/Anthropic API wired in directly, which
  is a separate, bigger piece of work, deliberately deferred pending real
  usage of the check buttons. Lead Forensics isn't connected at all yet.
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
2. Settings → **Domains & Routes** → add the custom domain
   `outreach.tsgroup.cloud` (already declared in `wrangler.jsonc`, but
   Cloudflare Custom Domains sometimes need adding once by hand the first
   time — if the route in `wrangler.jsonc` already claimed it on first
   deploy, this step is a no-op).
3. Once created, Settings → **Variables and Secrets** → add two encrypted
   secrets: `MS_PRIVATE_KEY_PKCS8` and `SESSION_SECRET`.

The D1 database (`tsg-outreach-portal-db`) and its one table already exist
and are wired into `wrangler.jsonc` — nothing to do there.

## Microsoft sign-in setup (Entra ID)

This portal has its own app registration, separate from `tsg-portal`'s:

1. Azure portal → Microsoft Entra ID → App registrations → **New
   registration**, name `TSG Outreach Portal`, account type "Accounts in
   any organizational directory (Multitenant)", redirect URI (Web)
   `https://outreach.tsgroup.cloud/auth/callback`.
2. Copy the **Application (client) ID** into `MS_CLIENT_ID` in
   `wrangler.jsonc`.
3. Certificates & secrets → Certificates → upload the public certificate
   generated for this app. Its private key (base64 PKCS8) is the
   `MS_PRIVATE_KEY_PKCS8` secret above; the cert's SHA-1 thumbprint is
   already in `wrangler.jsonc` as `MS_CERT_THUMBPRINT`.
4. `ALLOWED_EMAIL_DOMAINS` in `wrangler.jsonc` controls who's let in after
   signing in — currently `tapflopumps.co.uk,sychem.co.uk`.
5. For **Connect Outlook** (reuses this same app): App registration →
   **API permissions** → Add a permission → Microsoft Graph → Delegated →
   add `Mail.Read` and `Calendars.Read`. Grant admin consent if your
   tenant requires it. Also add a second **Web** redirect URI:
   `https://outreach.tsgroup.cloud/connect/outlook/callback`.

## Salesforce connection setup (per org)

Tapflo and Sychem each need their own Salesforce Connected App, in their
own org:

1. Salesforce Setup → App Manager → **New Connected App**.
2. Enable OAuth Settings. Callback URL:
   `https://outreach.tsgroup.cloud/connect/salesforce/callback` (same URL
   for both orgs — each org validates it independently).
3. Selected OAuth Scopes: **Manage user data via APIs (api)** and
   **Perform requests at any time (refresh_token, offline_access)**.
4. Save, then copy the **Consumer Key** and **Consumer Secret**.
5. Put the Consumer Key into `SALESFORCE_CLIENT_ID_TAPFLO` (or `_SYCHEM`)
   in `wrangler.jsonc`, the org's Salesforce login domain (e.g.
   `yourorg.my.salesforce.com`) into `SALESFORCE_DOMAIN_TAPFLO` (or
   `_SYCHEM`), and add the Consumer Secret as an encrypted Cloudflare
   secret named `SALESFORCE_CLIENT_SECRET_TAPFLO` (or `_SYCHEM`).
