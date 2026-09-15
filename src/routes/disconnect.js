import { verifySession, readCookie } from "../shared/session.js";

// Lets a person redo a Salesforce/Outlook connection from scratch - there
// was otherwise no way back if a connection got made with the wrong
// account (a real failure mode on tsg-portal - see outlook-callback.js).
async function requireSession(request, env) {
  const session = await verifySession(readCookie(request, "session"), env.SESSION_SECRET);
  if (!session) return { error: new Response(null, { status: 302, headers: { Location: "/" } }) };
  return { session };
}

export async function handleDisconnectSalesforce(request, env) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;
  await env.DB.prepare("DELETE FROM salesforce_connections WHERE user_id = ?").bind(session.userId).run();
  await env.DB.prepare("INSERT INTO activity_log (user_id, event) VALUES (?, 'salesforce_disconnected')").bind(session.userId).run();
  return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
}

export async function handleDisconnectOutlook(request, env) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;
  await env.DB.prepare("DELETE FROM outlook_connections WHERE user_id = ?").bind(session.userId).run();
  await env.DB.prepare("INSERT INTO activity_log (user_id, event) VALUES (?, 'outlook_disconnected')").bind(session.userId).run();
  return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
}
