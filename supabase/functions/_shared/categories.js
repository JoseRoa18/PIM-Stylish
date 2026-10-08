// Faucet categories — shared by the app (src/features/products/lib/categories.js
// re-exports this module) and the edge functions (completeness, Listing
// Health, Wayfair).
//
// "Kitchen Faucet Combo" and "Cold Water Tap" (user, 2026-10-08) are kitchen
// faucets for every rule, export and template: they only name the kind. A
// marketplace template tagged kitchen_faucet fits them, and every channel
// mapping reads them as kitchen_faucet (baseCategory).

export const KITCHEN_FAUCET_CATEGORIES = ['kitchen_faucet', 'kitchen_faucet_combo', 'cold_water_tap'];
export const FAUCET_CATEGORIES = [...KITCHEN_FAUCET_CATEGORIES, 'bathroom_faucet', 'pot_filler'];

export const isKitchenFaucetCategory = (category) => KITCHEN_FAUCET_CATEGORIES.includes(String(category ?? ''));
export const isFaucetCategory = (category) => FAUCET_CATEGORIES.includes(String(category ?? ''));

/** The category the channels and the marketplace templates know a category by. */
export const baseCategory = (category) => (isKitchenFaucetCategory(category) ? 'kitchen_faucet' : category);

// Colanders, drying racks and mats, dish racks and organizers and the
// workstation kits are Accessories since 2026-10-08 (user's file), but every
// channel still knows them as "Colanders & Drying Racks", so their templates,
// Wayfair class and Lowe's / Home Depot mappings stay as they were. A cutting
// or serving board "with Colander" (A-904, A-907) stays a cutting board.
const COLANDER_RACK_RE = /colander|drying rack|drying mat|dish rack|dish organizer|sink basket|accessories kit/i;
const BOARD_WITH_RE = /(cutting|serving) board with/i;
export function isColanderOrRack(product) {
  const t = `${product?.product_type ?? ''} ${product?.attributes?.general_title_en ?? ''} ${product?.model_name ?? ''}`;
  return COLANDER_RACK_RE.test(t) && !BOARD_WITH_RE.test(t);
}

/** The category the channels and the marketplace templates know a PRODUCT by. */
export function channelCategory(product) {
  const category = product?.category;
  if (category === 'accessory' && isColanderOrRack(product)) return 'colander_drying_rack';
  return baseCategory(category);
}
