// A single, tightly-scoped Claude API call for the one part of ZoomInfo
// lead-sourcing a keyword list genuinely can't do well: judging whether a
// real job title is a functional fit for a sector's target roles (not just
// a literal substring match), and how closely a specific company's profile
// resembles that sector's real closed-won customer base. Everything else in
// that pipeline (Salesforce/ZoomInfo/Outlook dedupe, "no email no lead")
// stays deterministic on purpose - only a classification/similarity
// judgment gets an LLM here, never a dedupe gate, where a false positive
// would mean re-contacting an existing customer.
//
// Needs the ANTHROPIC_API_KEY secret (Cloudflare dashboard, same pattern as
// LEADFORENSICS_API_KEY/ZOOMINFO_CLIENT_SECRET - never commit it). Best
// effort like every other gate in this file: if the key isn't set or the
// call fails, judgeLeadFit returns null and the caller falls back to the
// old substring role match and the sector's static ceiling score.

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const TOOL = {
  name: "judge_lead_fit",
  description:
    "Judge whether each job title found at a company is a genuine functional fit for a sector's target roles, and how closely the company's own profile resembles that sector's real closed-won reference customers.",
  input_schema: {
    type: "object",
    properties: {
      customerProfileScore: {
        type: "integer",
        description: "0 to maxCustomerProfileScore: how closely this company resembles the sector's real closed-won reference companies, given its industry, size and location. 0 if there's nothing to distinguish it either way.",
      },
      titles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            roleLevel: {
              type: "string",
              enum: ["core", "secondary", "none"],
              description: "core = a genuine functional match for one of the sector's core target titles, even if worded differently. secondary = a real but less central fit. none = not a genuine fit for this sector's target roles.",
            },
          },
          required: ["title", "roleLevel"],
        },
      },
      reasoning: { type: "string", description: "One or two sentences covering both judgments." },
    },
    required: ["customerProfileScore", "titles", "reasoning"],
  },
};

// titles: array of distinct job title strings found at this company.
export async function judgeLeadFit(env, { sectorKey, sectorDef, titles, companyName, city, state, employeeCount }) {
  if (!env.ANTHROPIC_API_KEY || !titles.length) return null;

  const location = [city, state].filter(Boolean).join(", ");
  const prompt = `Sector: ${sectorKey} - ${sectorDef.description}
Sector's core target titles: ${sectorDef.coreRoleKeywords.join(", ")}
Sector's secondary target titles: ${sectorDef.secondaryRoleKeywords.join(", ")}
Real closed-won reference companies for this sector: ${sectorDef.wonBusinessRef.length ? sectorDef.wonBusinessRef.join(", ") : "none documented yet for this sector - score customerProfileScore conservatively"}
Max possible customerProfileScore for this sector: ${sectorDef.customerProfileScore}

Candidate company: ${companyName}${location ? ` (${location})` : ""}${employeeCount ? `, ~${employeeCount} employees` : ""}
Job titles found there: ${titles.join(", ")}

For each job title, judge its functional fit against the sector's target roles - a title can match in function even if it doesn't literally contain one of the listed phrases (e.g. "Head of Engineering & Maintenance" can be a genuine core fit). Then score how closely this company's own profile resembles the sector's real closed-won reference companies.`;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "judge_lead_fit" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API failed (${res.status}): ${await res.text()}`);

  const body = await res.json();
  const toolUse = (body.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude API returned no tool_use block");
  const input = toolUse.input || {};

  const byTitle = new Map();
  for (const t of input.titles || []) {
    if (t && t.title) byTitle.set(t.title, t.roleLevel === "core" || t.roleLevel === "secondary" ? t.roleLevel : null);
  }
  const customerProfileScore = Math.max(0, Math.min(sectorDef.customerProfileScore, Number(input.customerProfileScore) || 0));

  return { byTitle, customerProfileScore, reasoning: input.reasoning || "" };
}
