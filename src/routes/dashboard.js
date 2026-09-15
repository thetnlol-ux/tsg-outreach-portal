import { verifySession, readCookie } from "../shared/session.js";

// The landing spot right after signing in - shows connection status for
// Salesforce/Outlook with a clear Connect/Disconnect button for each
// (same card pattern as tsg-portal's own /dashboard), then a link into
// the actual outreach desk at /app. Keeping this separate from /app means
// a stuck connection flow never leaves someone unable to find the rest of
// the page - it's a full server-rendered page, not one squeezed into the
// big app's own header.
export async function handleDashboard(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }

  const sfConnection = await env.DB.prepare(
    "SELECT instance_url, connected_at FROM salesforce_connections WHERE user_id = ?"
  )
    .bind(session.userId)
    .first();
  const sfStatus = connectionRow(
    "Salesforce",
    sfConnection,
    "/connect/salesforce",
    "/connect/salesforce/disconnect"
  );

  const olConnection = await env.DB.prepare(
    "SELECT connected_at FROM outlook_connections WHERE user_id = ?"
  )
    .bind(session.userId)
    .first();
  const olStatus = connectionRow(
    "Outlook",
    olConnection,
    "/connect/outlook",
    "/connect/outlook/disconnect"
  );

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard — TSG Outreach Portal</title>
<link rel="icon" type="image/png" href="/brand/favicon.png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    color-scheme: light dark;
    --paper:#F6F8FA; --surface:#FFFFFF; --surface-subtle:#F2F8FC;
    --ink:#0D1B2A; --sub:#565B60; --faint:#8FA0AC;
    --line:#D5E2EE; --line-subtle:#E4EFF8;
    --accent:#004B87; --accent-strong:#002845; --accent-cyan:#00AEEF; --accent-soft:#E4EFF8;
    --success:#1F8A5B; --success-soft:#E2F1EA;
    --radius-md:10px; --radius-lg:18px; --radius-pill:999px;
    --shadow-md:0 10px 28px rgba(13,27,42,.10), 0 2px 6px rgba(13,27,42,.06);
  }
  @media (prefers-color-scheme: dark){
    :root{
      --paper:#0B1520; --surface:#122234; --surface-subtle:#152A3F;
      --ink:#EAF1F8; --sub:#A9B7C4; --faint:#5E7387;
      --line:#22384C; --line-subtle:#1B2E40;
      --accent:#3FA9F5; --accent-strong:#7FD6FB; --accent-cyan:#3FD1FB; --accent-soft:#132A3C;
      --success:#3FC088; --success-soft:#123A2C;
      --shadow-md:0 10px 28px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3);
    }
  }
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--paper);color:var(--ink);font-family:"Roboto",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;}
  .card{max-width:460px;width:100%;padding:36px 32px;background:var(--surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-md);}
  .co{display:flex;justify-content:center;margin-bottom:18px;}
  .co img{height:30px;width:auto;}
  .co .logo-dark{display:none;}
  @media (prefers-color-scheme: dark){ .co .logo-light{display:none;} .co .logo-dark{display:block;} }
  h1{font-size:22px;margin:0 0 4px;text-align:center;font-weight:700;letter-spacing:-0.01em;}
  .meta{color:var(--sub);margin:0 0 24px;font-size:14px;text-align:center;}
  .section-label{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin:22px 0 10px;}
  .row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line-subtle);font-size:14px;}
  .row-label{display:flex;align-items:center;gap:8px;font-weight:500;}
  .badge{display:inline-block;font-size:11px;font-weight:700;padding:3px 9px;border-radius:var(--radius-pill);text-transform:uppercase;letter-spacing:.03em;}
  .badge-on{background:var(--success-soft);color:var(--success);}
  .badge-off{background:var(--line-subtle);color:var(--faint);}
  .btn2{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:var(--radius-pill);cursor:pointer;text-decoration:none;border:1px solid transparent;white-space:nowrap;transition:box-shadow .15s ease, opacity .15s ease;}
  .btn2-primary{background:var(--accent);color:#fff;box-shadow:0 1px 2px rgba(13,27,42,.15);}
  .btn2-primary:hover{opacity:.92;}
  .btn2-ghost{background:transparent;color:var(--accent);border-color:var(--line);}
  .btn2-ghost:hover{border-color:var(--accent);}
  .open-desk{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:26px;padding:13px 14px;border-radius:var(--radius-md);background:var(--accent);color:#fff;text-decoration:none;font-weight:700;font-size:15px;box-shadow:0 1px 2px rgba(13,27,42,.15);}
  .open-desk:hover{opacity:.92;}
  .foot{margin-top:20px;padding-top:18px;border-top:1px solid var(--line-subtle);display:flex;justify-content:center;gap:14px;flex-wrap:wrap;}
</style></head>
<body>
  <div class="card">
    <div class="co">
      <img class="logo-light" src="/brand/tsgroup-logo-dark.svg" alt="TS Group">
      <img class="logo-dark" src="/brand/tsgroup-logo-white.svg" alt="TS Group">
    </div>
    <h1>Signed in as ${escapeHtml(session.displayName)}</h1>
    <p class="meta">${escapeHtml(session.email)}</p>

    <div class="section-label">Connections</div>
    ${sfStatus}
    ${olStatus}

    <a class="open-desk" href="/app">Open Outreach Desk →</a>

    <div class="foot">
      <a class="btn2 btn2-ghost" href="/auth/logout">Sign out</a>
    </div>
  </div>
</body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

function connectionRow(label, connection, connectHref, disconnectHref) {
  return connection
    ? `<div class="row">
        <div class="row-label"><span class="badge badge-on">Connected</span> ${escapeHtml(label)}</div>
        <a class="btn2 btn2-ghost" href="${disconnectHref}">Disconnect &amp; reconnect</a>
      </div>`
    : `<div class="row">
        <div class="row-label"><span class="badge badge-off">Not connected</span> ${escapeHtml(label)}</div>
        <a class="btn2 btn2-primary" href="${connectHref}">Connect</a>
      </div>`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
