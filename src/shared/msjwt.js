// Everything needed to talk to Microsoft's identity platform as a
// "certificate credential" app rather than a client-secret app - same
// approach tsg-portal uses (some TS Group tenants block plain client
// secrets outright).
//
// Concretely: Microsoft will accept a self-signed JWT ("client assertion"),
// proven authentic because it's signed with the private half of the
// certificate whose public half was uploaded to the app registration.

const encoder = new TextEncoder();

function base64url(bytes) {
  const str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

async function importSigningKey(pkcs8Base64) {
  // Defensive: a value this long, hand-pasted into a web form, is an easy
  // place for a stray character (a smart quote, a line break treated
  // oddly) to sneak in. Anything outside the actual base64 alphabet is
  // stripped before decoding, rather than the whole sign-in flow crashing
  // over one invisible character.
  const clean = pkcs8Base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const der = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

export async function buildClientAssertion({
  clientId,
  tokenEndpoint,
  certThumbprintHex,
  privateKeyPkcs8Base64,
}) {
  const header = { alg: "RS256", typ: "JWT", x5t: base64url(hexToBytes(certThumbprintHex)) };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenEndpoint,
    jti: crypto.randomUUID(),
    nbf: now - 5,
    iat: now,
    exp: now + 300,
  };
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await importSigningKey(privateKeyPkcs8Base64);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

// Reads the id_token's claims WITHOUT re-verifying the signature. That's
// safe here specifically because this id_token came back on the direct
// server-to-server HTTPS call we just made to Microsoft's own token
// endpoint - nothing passed through the browser or a third party in between.
export function decodeJwtPayload(jwt) {
  const part = jwt.split(".")[1];
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}

export async function pkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  const challenge = base64url(digest);
  return { verifier, challenge };
}
