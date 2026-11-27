// A sink sold with its faucet in the box (user, 2026-11-27: "los modelos S-520C
// sí incluyen faucet … un campo que diga Faucet included y si se le coloca sí,
// sale otro campo que diga faucet finish"). S-520C1 is the S-520C with the
// K-151S foldable faucet, S-520C2 with the K-151N; the S-520C alone has none.
//
// One reading for the product page, the Wayfair push and new listing, and the
// marketplace files, so they never disagree:
//   - the product page's Faucet Included switch (attributes.faucet_included);
//   - a sink where the switch was never touched says it through its Included
//     Accessories list, when that names a faucet ("K-151S Foldable Faucet") —
//     what the Wayfair push read until that day;
//   - a switch turned off (a stored false) is a No, whatever the list says.
// Only a sink has the field: a faucet is not "included" with itself.
//
// Faucet Finish (attributes.faucet_finish) is the finish of THAT faucet — the
// sink's own Finish is another thing (S-520C2: a Dura-Tek sink with a Matte
// Black faucet) — and counts only while a faucet is included.

const text = (v) => String(v ?? '').trim();
const listOf = (v) => (Array.isArray(v) ? v : text(v) ? text(v).split(/[;,]/) : []).map(text).filter(Boolean);
// "K-151S Foldable Faucet" is a faucet; "Faucet Hole Cover" is a cover.
const namesFaucet = (item) => /faucet/i.test(item) && !/faucet holes?/i.test(item);

/** Is this product a sink (the only kind that can come with a faucet)? */
export const takesIncludedFaucet = (product) => /sink/.test(String(product?.category ?? ''));

/** Does this sink come with a faucet in the box? */
export function faucetIncluded(product) {
  if (!takesIncludedFaucet(product)) return false;
  const a = product?.attributes ?? {};
  const stored = a.faucet_included;
  if (stored === true || /^(yes|true)$/i.test(text(stored))) return true;
  if (stored === false || /^(no|false)$/i.test(text(stored))) return false;
  return listOf(a.accessories_included).some(namesFaucet);
}

/** The finish of the faucet a sink comes with ("Matte Black"); '' without one, or while the PIM has none. */
export function faucetFinish(product) {
  return faucetIncluded(product) ? text(product?.attributes?.faucet_finish) : '';
}
