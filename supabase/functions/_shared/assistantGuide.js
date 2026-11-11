// The assistant's guide: its index, and the user guide made from the
// developers' one.
//
// The guide is CLAUDE.md cut into pieces (scripts/sync-assistant-knowledge.mjs).
// Admins are answered from those pieces as they are. Everyone else is
// answered from a USER GUIDE: each piece rewritten for a person who uses the
// app and does not program — the rules, dates and numbers stay; file,
// function and table names, deployment, tests and how access is enforced go.
// A piece with nothing left for a user, or about something only a few people
// may see, is left out of it. A rewrite is kept by the hash of the piece it
// came from, so only a piece that changed is rewritten again.
//
// No SDK import here: the `assistant` edge function passes its client in.

export const USER_GUIDE_MODEL = "claude-sonnet-5-5";

/** One line per piece, under its section: what the model is always shown. */
export function guideIndexOf(pieces) {
  const lines = [];
  let shown = null;
  for (const piece of pieces) {
    if (piece.section !== shown) {
      lines.push(`\n## ${piece.section}`);
      shown = piece.section;
    }
    lines.push(`${piece.id} — ${piece.lead}`);
  }
  return lines.join("\n").trim();
}

/** A short, stable name for a piece's text (the first 16 hex digits of its SHA-256). */
export async function hashOf(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const REWRITE = `You are preparing the user guide of Stylish PIM, the product information system used by the team of a kitchen and bath company (brands Stylish and Azuni). You will get one piece of the developers' internal documentation. Rewrite it as one piece of the user guide, for colleagues who use the app and do not program.

Keep everything a person using the app needs: what a page, tab, button or automatic process does; when it runs; what it sends and where; what is allowed, refused or warned about, and why; who decided a rule and when (dates stay); the numbers that define a rule (margins, limits, schedules). Keep the names of pages, tabs, buttons and fields exactly as written.

Leave out everything only a programmer needs: file names and paths, function, component and variable names, database tables and columns, migrations, the names of server functions and the shape of their requests, API endpoints, HTML, CSS and accessibility implementation, build and deployment, notes about how something was tested or checked, credentials, keys and secrets, and how access is enforced technically. Where a rule is stated through such a name, state the rule in plain words instead.

Do not add anything that is not in the piece, and do not mention what you removed.

Answer in exactly this shape:
AUDIENCE: all
TITLE: <a short title for the piece, at most 90 characters>
<the rewritten piece: plain English paragraphs or a short list>

Answer with the single line
AUDIENCE: admin
only in two cases: once the programmer-only content is removed, nothing a user could act on or learn from remains (the piece is purely about code, infrastructure or testing); or the piece describes something that only a few people named one by one are allowed to see. Something shown to a role — admins, editors — is not such a case: the guide says who sees it. When in doubt, the piece belongs in the guide.`;

/**
 * One piece rewritten for users.
 * Returns { audience: 'all', lead, text } or { audience: 'admin' }, with the
 * usage of the call. Throws when the answer was cut short (it is asked again
 * on the next run).
 */
export async function rewritePiece({ anthropic, piece }) {
  const message = await anthropic.messages.create({
    model: USER_GUIDE_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    system: REWRITE,
    messages: [{ role: "user", content: `Section of the documentation: ${piece.section}\n\n<piece>\n${piece.text}\n</piece>` }],
  });
  const usage = message.usage ?? {};
  if (message.stop_reason === "refusal") return { audience: "admin", usage };
  if (message.stop_reason === "max_tokens") throw new Error(`The rewrite of piece ${piece.id} was cut short.`);
  const answer = (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (/^AUDIENCE:\s*admin\b/i.test(answer) || !answer) return { audience: "admin", usage };
  const body = answer.replace(/^AUDIENCE:[^\n]*\n?/i, "").trim();
  const title = body.match(/^TITLE:\s*(.+)$/im);
  const text = body.replace(/^TITLE:[^\n]*\n?/im, "").trim();
  if (!text) return { audience: "admin", usage };
  const lead = (title ? title[1] : text.replace(/\s+/g, " ")).trim().slice(0, 130);
  return { audience: "all", lead, text, usage };
}
