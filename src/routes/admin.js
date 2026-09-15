import { verifySession, readCookie } from "../shared/session.js";

function adminEmails(env) {
  return (env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(env, email) {
  return adminEmails(env).includes((email || "").toLowerCase());
}

// The Control Centre - who's using the portal, and whether they've
// connected Salesforce/Outlook. Same oversight idea as tsg-portal's
// /admin, adapted for a portal with no companies/roles table: admin
// access is just an email allowlist (ADMIN_EMAILS in wrangler.jsonc),
// not a role column.
export async function handleAdmin(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  if (!isAdmin(env, session.email)) {
    return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
  }

  const [users, activity] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.display_name, u.email, u.created_at, u.last_login_at,
              sf.connected_at AS sf_connected_at,
              ol.connected_at AS ol_connected_at
       FROM users u
       LEFT JOIN salesforce_connections sf ON sf.user_id = u.id
       LEFT JOIN outlook_connections ol ON ol.user_id = u.id
       ORDER BY u.last_login_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT a.event, a.created_at, u.display_name, u.email
       FROM activity_log a
       JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT 50`
    ).all(),
  ]);

  const userRows = users.results || [];
  const activityRows = activity.results || [];
  const totalUsers = userRows.length;
  const activeToday = userRows.filter((u) => isToday(u.last_login_at)).length;
  const sfConnected = userRows.filter((u) => u.sf_connected_at).length;
  const olConnected = userRows.filter((u) => u.ol_connected_at).length;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Control Centre — TSG Outreach Portal</title>
<link rel="icon" type="image/png" href="/brand/favicon.png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    color-scheme: light dark;
    --paper:#F6F8FA; --panel:#FFFFFF; --ink:#0D1B2A; --sub:#565B60; --faint:#8FA0AC;
    --accent:#004B87; --accent-soft:#E4EFF8; --line:#D5E2EE;
    --success:#1F8A5B; --success-soft:#E2F1EA;
    --radius-md:10px; --radius-lg:16px; --shadow-sm:0 1px 3px rgba(13,27,42,.07);
  }
  @media (prefers-color-scheme: dark){
    :root{
      --paper:#0B1520; --panel:#122234; --ink:#EAF1F8; --sub:#A9B7C4; --faint:#5E7387;
      --accent:#3FA9F5; --accent-soft:#132A3C; --line:#22384C;
      --success:#3FC088; --success-soft:#123A2C;
      --shadow-sm:0 1px 3px rgba(0,0,0,.3);
    }
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:"Roboto",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;}
  .wrap{max-width:960px;margin:0 auto;padding:40px 24px 80px;}
  header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:28px;}
  h1{font-size:24px;margin:0;font-weight:700;letter-spacing:-0.01em;}
  .out{color:var(--accent);font-size:13.5px;text-decoration:none;font-weight:500;}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:36px;}
  .stat{background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow-sm);border-radius:var(--radius-lg);padding:16px 18px;}
  .stat .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;}
  .stat .l{font-size:12.5px;color:var(--sub);margin-top:2px;}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);border-bottom:1px solid var(--line);padding-bottom:8px;margin:0 0 14px;}
  section{margin-bottom:40px;}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:600;padding:0 10px 8px;}
  td{padding:10px 10px;border-top:1px solid var(--line);}
  tr:first-child td{border-top:none;}
  .pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.03em;}
  .pill-on{background:var(--success-soft);color:var(--success);}
  .pill-off{background:var(--line);color:var(--faint);}
  .muted{color:var(--faint);}
  .scroll{overflow-x:auto;}
  .empty{color:var(--faint);font-size:13.5px;padding:16px 0;}
</style></head>
<body>
  <div class="wrap">
    <header>
      <h1>Control Centre</h1>
      <div>
        <a class="out" href="/dashboard">Dashboard</a> &middot;
        <a class="out" href="/auth/logout">Sign out</a>
      </div>
    </header>

    <div class="stats">
      <div class="stat"><div class="n">${totalUsers}</div><div class="l">Users</div></div>
      <div class="stat"><div class="n">${activeToday}</div><div class="l">Active today</div></div>
      <div class="stat"><div class="n">${sfConnected}</div><div class="l">Salesforce connected</div></div>
      <div class="stat"><div class="n">${olConnected}</div><div class="l">Outlook connected</div></div>
    </div>

    <section>
      <h2>Users</h2>
      <div class="scroll"><table>
        <tr><th>Name</th><th>Email</th><th>Salesforce</th><th>Outlook</th><th>Last active</th></tr>
        ${
          userRows.length
            ? userRows
                .map(
                  (u) =>
                    `<tr><td>${escapeHtml(u.display_name)}</td><td class="muted">${escapeHtml(u.email)}</td><td>${pill(!!u.sf_connected_at)}</td><td>${pill(!!u.ol_connected_at)}</td><td class="muted">${relativeTime(u.last_login_at)}</td></tr>`
                )
                .join("")
            : `<tr><td colspan="5" class="empty">No one's signed in yet.</td></tr>`
        }
      </table></div>
    </section>

    <section>
      <h2>Recent activity</h2>
      <div class="scroll"><table>
        <tr><th>Who</th><th>Event</th><th>When</th></tr>
        ${
          activityRows.length
            ? activityRows
                .map(
                  (a) =>
                    `<tr><td>${escapeHtml(a.display_name)}</td><td>${escapeHtml(a.event)}</td><td class="muted">${relativeTime(a.created_at)}</td></tr>`
                )
                .join("")
            : `<tr><td colspan="3" class="empty">Nothing logged yet.</td></tr>`
        }
      </table></div>
    </section>
  </div>
</body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

function pill(on) {
  return on ? '<span class="pill pill-on">Connected</span>' : '<span class="pill pill-off">Not connected</span>';
}

function isToday(sqliteDatetime) {
  if (!sqliteDatetime) return false;
  const then = new Date(sqliteDatetime.replace(" ", "T") + "Z");
  const now = new Date();
  return then.toDateString() === now.toDateString();
}

function relativeTime(sqliteDatetime) {
  if (!sqliteDatetime) return "never";
  const then = new Date(sqliteDatetime.replace(" ", "T") + "Z").getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
