// Shared AI description formatter — used by ai-format-html (the manual
// Auto-format button) and by wix-push-product (EVERY push formats the
// description before it leaves, rule 2026-08-31).
//
// Contract: the text is laid out in the SinksDirect house style (bold
// product-name headline injected by code, plain separated paragraphs) and
// only TYPOGRAPHICAL repairs are allowed — the word-level validator rejects
// any response that rewords. Returns null when Gemini can't produce a valid
// layout; callers then fall back to the unformatted text.

const normalize = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    // Tag-stripping turns "<strong>word</strong>." into "word ." — spacing
    // around punctuation is layout, not wording, so it never fails the match.
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();

const PROMPT = `You are a formatter and proofreader. Reformat the product description below as HTML:
- Split the prose into plain <p> paragraphs at natural topic breaks, with exactly one empty <p>&nbsp;</p> between paragraphs (that is how the store spaces them).
- Fix ONLY obvious typographical errors: missing or extra letters, doubled words, stray or misplaced punctuation, wrong capitalization at sentence starts.
- NO bold, NO lists, NO headings. Allowed tags ONLY: p, br.
CRITICAL: never reword, rephrase, reorder or summarize. Do not swap a word for a different word — only repair misspelled ones. Every sentence keeps its exact wording. Output ONLY the HTML, no code fences, no commentary.

TEXT:
`;

async function gemini(apiKey: string, text: string, strict: boolean): Promise<string> {
  const body = {
    contents: [{ parts: [{ text: PROMPT + text + (strict ? "\n\nREMINDER: your previous attempt changed the wording. Copy the text VERBATIM — only add HTML tags." : "") }] }],
    generationConfig: { temperature: 0 },
  };
  const resp = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  let out: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  out = out.replace(/^```(?:html)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  // Cosmetic: no space between a closing tag and following punctuation.
  out = out.replace(/<\/(strong|em)>\s+([,.;:!?])/g, "</$1>$2");
  return out;
}

// ---------- verbatim-except-typos validator ---------------------------------
// The output may differ from the input ONLY by typographical repairs: each
// changed word must be a small edit of the original (Levenshtein <= 2, or a
// join/split like "bath room" -> "bathroom"), doubled words may collapse,
// and the total number of repaired words is capped. Substituting a word for
// a DIFFERENT word ("good" -> "great") fails the distance test and rejects
// the whole response.

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function onlyTypoFixes(src: string, out: string): { ok: boolean; fixes: string[] } {
  if (src === out) return { ok: true, fixes: [] };
  const A = src.split(" ");
  const B = out.split(" ");
  // LCS over words (case/punctuation-insensitive key) to align the texts.
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return { ok: false, fixes: [] };
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = key(A[i]) === key(B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const fixes: string[] = [];
  let i = 0, j = 0;
  let repaired = 0;
  const fail = { ok: false, fixes: [] as string[] };
  const repair = (label: string) => { fixes.push(label); repaired++; };
  while (i < n || j < m) {
    if (i < n && j < m && key(A[i]) === key(B[j])) {
      if (A[i] !== B[j]) {
        // same word, different case/punctuation — typo-level repair
        if (levenshtein(A[i], B[j]) > 2) return fail;
        repair(`${A[i]} -> ${B[j]}`);
      }
      i++; j++;
      continue;
    }
    const canDelete = i < n && (j >= m || dp[i + 1][j] === dp[i][j]);
    const canInsert = j < m && (i >= n || dp[i][j + 1] === dp[i][j]);
    if (canDelete && canInsert && i < n && j < m) {
      // substitution slot: must be a spelling repair, a join, or a split
      const a = A[i], b = B[j];
      if (levenshtein(a, b) <= 2) { repair(`${a} -> ${b}`); i++; j++; continue; }
      if (i + 1 < n && levenshtein(A[i] + A[i + 1], b) <= 1) { repair(`${a} ${A[i + 1]} -> ${b}`); i += 2; j++; continue; }
      if (j + 1 < m && levenshtein(a, B[j] + B[j + 1]) <= 1) { repair(`${a} -> ${b} ${B[j + 1]}`); i++; j += 2; continue; }
      return fail;
    }
    if (canDelete) {
      // deletion allowed only for a doubled word ("the the" -> "the")
      if (i > 0 && key(A[i]) === key(A[i - 1]) && key(A[i]) !== "") { repair(`${A[i - 1]} ${A[i]} -> ${A[i - 1]}`); i++; continue; }
      return fail;
    }
    return fail; // insertion of a new word = rewording
  }
  const cap = Math.max(4, Math.round(A.length * 0.06));
  return repaired <= cap ? { ok: true, fixes } : fail;
}


export const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface FormatResult { html: string; fixes: string[] }

export async function formatDescription(
  apiKey: string,
  text: string,
  headline: string,
): Promise<FormatResult | null> {
  const source = normalize(text);
  if (!source || source.length > 8000) return null;
  const headlineHtml = headline.trim()
    ? `<p><strong>${escapeHtml(headline.trim())}</strong></p><p>&nbsp;</p>`
    : "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const html = await gemini(apiKey, source, attempt > 0);
    const verdict = onlyTypoFixes(source, normalize(html));
    // The store's own descriptions are single-line HTML — whitespace between
    // tags renders as extra gaps on Wix, so compact it away.
    const compact = html.replace(/>\s+</g, "><").trim();
    if (verdict.ok) return { html: headlineHtml + compact, fixes: verdict.fixes };
  }
  return null;
}

export { normalize };
