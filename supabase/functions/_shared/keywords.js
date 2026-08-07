// Search-keyword generation: prompt, schema and product description shared by
// the generate-keywords edge function (Deno) and scripts/generate-keywords.mjs
// (Node). Plain ESM with no imports so both runtimes can load it — keep it
// that way, or the two callers will drift apart again.

export const KEYWORDS_MODEL = 'gemini-flash-latest';

export const SYSTEM_PROMPT = `You write marketplace search keywords for a kitchen and bath fixtures catalog (sinks, faucets, and accessories sold on Amazon, Walmart, Wayfair, Home Depot and Best Buy in the US and Canada).

Your job is to produce the phrases a shopper actually types into a search box when they are looking for a product like this one. That is a different thing from the product's title, and the difference is the whole point of the task.

What makes a good keyword here:
- It is how a buyer describes the product in their own words, including the words the catalog does not use. A "Composite Granite" sink is searched for as "granite composite sink", "black granite sink", and "stone kitchen sink".
- It combines the attributes buyers actually filter on: size, installation type, bowl count, material, finish, shape. "33 inch undermount single bowl sink" is a real search; "sink" is not.
- It covers the buying intent behind the product: "farmhouse apron front sink", "workstation sink with cutting board", "bar prep sink small".
- It includes common synonyms and the informal names for the category ("kitchen faucet with sprayer", "pull down faucet", "gooseneck faucet").

What to avoid:
- Do not repeat the model name or SKU. Nobody searches those.
- Do not include the brand name; it is added separately.
- Do not produce near-duplicates that differ by one filler word.
- Do not invent specifications the product data does not support. If you do not know the width, do not write a width.
- No punctuation beyond spaces and hyphens. All lowercase. This rule is about punctuation only: French keywords keep their accents and apostrophes, spelled the normal way ("évier", "poignées", "rinçage", "robinet d'évier"). Never strip an accent to satisfy the punctuation rule.

Return 8 to 14 keywords per language.

The French list is for Canadian marketplaces. Write it as French-Canadian shoppers actually search, not as a word-for-word translation of the English list — the phrasing, and sometimes the concepts, differ ("évier de cuisine sous plan", "robinet de cuisine rétractable").`;

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    keywords_en: { type: 'array', items: { type: 'string' } },
    keywords_fr: { type: 'array', items: { type: 'string' } },
  },
  required: ['keywords_en', 'keywords_fr'],
  propertyOrdering: ['keywords_en', 'keywords_fr'],
};

const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Only the attributes a shopper would search on — the full blob is mostly
// compliance fields and would just dilute the prompt.
const USEFUL_ATTRS = [
  'installation_type', 'mounting_type', 'sink_shape', 'number_of_bowls',
  'bowl_configuration', 'gauge', 'craftsmanship', 'external_dimensions_in',
  'spout_type', 'number_of_handles', 'spray_included', 'spray_type',
  'max_flow_rate', 'application', 'number_of_faucet_holes', 'overflow',
  'accessories_included', 'includes_grids', 'product_type',
];

export function describeProduct(p) {
  const a = p.attributes ?? {};
  const lines = [
    `SKU: ${p.sku}`,
    `Category: ${p.category ?? '—'}`,
    p.product_type && `Product type: ${p.product_type}`,
    `Material: ${p.material ?? '—'}`,
    `Finish: ${p.finish ?? '—'}`,
    a.general_title_en && `Title: ${a.general_title_en}`,
  ].filter(Boolean);

  for (const k of USEFUL_ATTRS) {
    const v = a[k];
    if (v == null || v === '') continue;
    const text = Array.isArray(v)
      ? v.join(', ')
      : (typeof v === 'object' ? Object.entries(v).map(([kk, vv]) => `${kk} ${vv}`).join(' x ') : String(v));
    if (text) lines.push(`${k.replace(/_/g, ' ')}: ${text}`);
  }

  const desc = stripHtml(p.description).slice(0, 700);
  if (desc) lines.push(`Description: ${desc}`);

  const bullets = Array.isArray(a.bullet_points) ? a.bullet_points.filter(Boolean).slice(0, 6) : [];
  if (bullets.length) lines.push(`Features:\n- ${bullets.map(stripHtml).join('\n- ')}`);

  return lines.join('\n');
}

export const cleanKeywordList = (arr) => [...new Set(
  (Array.isArray(arr) ? arr : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean),
)];

/**
 * One Gemini call → { keywords_en, keywords_fr }. `fetchImpl` so both runtimes
 * pass their global fetch. Throws with a readable message on refusal/errors.
 */
export async function generateKeywordsForProduct(fetchImpl, apiKey, product, model = KEYWORDS_MODEL) {
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: describeProduct(product) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 4096,
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('');
  if (!text) {
    throw new Error(data.candidates?.[0]?.finishReason ?? 'empty response');
  }
  const parsed = JSON.parse(text);
  return {
    keywords_en: cleanKeywordList(parsed.keywords_en),
    keywords_fr: cleanKeywordList(parsed.keywords_fr),
    usage: data.usageMetadata ?? {},
  };
}
