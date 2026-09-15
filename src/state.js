// Persists the portal's editable state (leads, mailshot-sent flags,
// never-contact list) as one JSON blob in D1. Optimistic concurrency via
// `version`: a save has to name the version it started from, and is
// rejected with 409 if the row has moved on since - same "somebody else
// saved first" case the old Claude.ai artifact self-save handled.

export async function handleGetState(request, env) {
  const row = await env.DB.prepare(
    "SELECT data, version FROM portal_state WHERE id = 1"
  ).first();

  if (!row) return json({ data: null, version: 0 });
  return json({ data: JSON.parse(row.data), version: row.version });
}

export async function handleSaveState(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body.data !== "object" || body.data === null) {
    return json({ error: "missing data" }, 400);
  }

  const clientVersion = Number.isFinite(body.version) ? body.version : 0;
  const dataText = JSON.stringify(body.data);
  const now = new Date().toISOString();

  const existing = await env.DB.prepare(
    "SELECT version FROM portal_state WHERE id = 1"
  ).first();

  if (!existing) {
    if (clientVersion !== 0) return json({ error: "conflict", version: 0 }, 409);
    await env.DB.prepare(
      "INSERT INTO portal_state (id, data, version, updated_at) VALUES (1, ?, 1, ?)"
    ).bind(dataText, now).run();
    return json({ version: 1 });
  }

  if (existing.version !== clientVersion) {
    return json({ error: "conflict", version: existing.version }, 409);
  }

  const nextVersion = existing.version + 1;
  await env.DB.prepare(
    "UPDATE portal_state SET data = ?, version = ?, updated_at = ? WHERE id = 1"
  ).bind(dataText, nextVersion, now).run();
  return json({ version: nextVersion });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
