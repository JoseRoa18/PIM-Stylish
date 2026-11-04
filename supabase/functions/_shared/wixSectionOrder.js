/**
 * The order of a Wix product page's info sections (user, 2026-11-04: "el
 * orden debe ser estrictamente Dimensions, Features, Technical Documents,
 * Where to Buy" — WHERE TO BUY always last, never first). Any other section
 * (RECOMMENDED ACCESSORIES, VIDEOS…) keeps its place among the others, after
 * the documents and before WHERE TO BUY. Shared by the product push
 * (deriveWixSectionsFromPim) and the WHERE TO BUY publish (where-to-buy-audit).
 */
const RANKS = [
  [/DIMENSION/i, 0],
  [/FEATURE/i, 1],
  [/DOCUMENT|DOWNLOAD/i, 2],
  [/where\s*to\s*buy/i, 4],
];
const rankOf = (title) => RANKS.find(([re]) => re.test(String(title ?? '')))?.[1] ?? 3;

/** The sections in that order (a stable sort: equal ranks keep their order). */
export function orderWixSections(sections) {
  return (sections ?? [])
    .map((s, i) => ({ s, i, r: rankOf(s?.title) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}
