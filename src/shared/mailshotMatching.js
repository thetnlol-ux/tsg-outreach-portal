// Live topic/content matching for sourced mailshot candidates - replaces
// the per-row tech/topic/content-index/tier/why fields that were
// originally worked out by a human or Claude reading each subject line
// individually. This is deliberately a plain keyword match, not a
// fabricated "smart" read: it says exactly which words matched, and never
// invents a nuanced explanation it can't back up.
//
// The content library itself (MAILSHOT_CONTENT/MAILSHOT_TECHS) lives only
// in public/app.html, baked in as plain JS consts - rather than duplicate
// ~160KB of blog/case-study copy into a second server-side file (which
// would drift the moment one is edited and not the other), this reads the
// Worker's own deployed app.html via the ASSETS binding and extracts them
// the same way a one-off Python script extracted tapfloLeads earlier this
// project - a small bracket-matching scanner, since JS has no built-in
// "parse from this position and tell me where it ended".
function extractJsonLiteral(text, startIdx) {
  const openChar = text[startIdx];
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("extractJsonLiteral: no matching close bracket found");
}

function extractConst(html, constName) {
  const marker = `const ${constName} = `;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const litStart = start + marker.length;
  const litEnd = extractJsonLiteral(html, litStart);
  return JSON.parse(html.slice(litStart, litEnd));
}

let cachedLibrary = null; // per-isolate cache - the content library only changes on a deploy

export async function fetchContentLibrary(env, baseUrl) {
  if (cachedLibrary) return cachedLibrary;
  const res = await env.ASSETS.fetch(new URL("/app.html", baseUrl));
  if (!res.ok) throw new Error(`Could not read app.html for the content library (${res.status})`);
  const html = await res.text();
  cachedLibrary = {
    content: extractConst(html, "MAILSHOT_CONTENT") || [],
    techs: extractConst(html, "MAILSHOT_TECHS") || [],
  };
  return cachedLibrary;
}

const STOPWORDS = new Set([
  "the", "a", "an", "for", "and", "or", "to", "of", "in", "on", "with", "your", "you",
  "we", "our", "is", "are", "at", "re", "fw", "fwd", "hi", "hello", "regarding", "about",
]);

function significantWords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/^(re|fw|fwd)\s*:\s*/i, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Matches a subject line against the tech categories first (each has a
// short label, e.g. "ATEX rated"), then against individual content titles/
// standfirsts for the specific piece to suggest. Confidence (tier) is
// honest about how many real word overlaps it found - 1-2 shared words is
// a loose match worth a human double-check before sending, not a strong one.
export function matchSubjectToContent(subject, library) {
  const subjectWords = new Set(significantWords(subject));
  if (subjectWords.size === 0) return null;

  let bestTech = null;
  let bestTechOverlap = 0;
  for (const t of library.techs || []) {
    const techWords = significantWords(t.label);
    const overlap = techWords.filter((w) => subjectWords.has(w)).length;
    if (overlap > bestTechOverlap) { bestTechOverlap = overlap; bestTech = t; }
  }
  if (!bestTech || bestTechOverlap === 0) return null;

  let bestContentIdx = -1;
  let bestContentOverlap = 0;
  let bestMatchedWords = [];
  library.content.forEach((c, idx) => {
    const contentWords = new Set([...significantWords(c.title), ...significantWords(c.standfirst)]);
    const matched = [...subjectWords].filter((w) => contentWords.has(w));
    if (matched.length > bestContentOverlap) {
      bestContentOverlap = matched.length;
      bestContentIdx = idx;
      bestMatchedWords = matched;
    }
  });
  if (bestContentIdx === -1) return null;

  const tier = bestContentOverlap >= 3 ? 4 : bestContentOverlap === 2 ? 3 : 2;
  const why = `Your subject line shared the word${bestMatchedWords.length > 1 ? "s" : ""} "${bestMatchedWords.join('", "')}" with this piece (${bestContentOverlap} word${bestContentOverlap > 1 ? "s" : ""} in common) - a plain keyword match, not a read of the actual thread.`;

  return { tech: bestTech.key, topic: bestTech.label, contentIndex: bestContentIdx, tier, why };
}
