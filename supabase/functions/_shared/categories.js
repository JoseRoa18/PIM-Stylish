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

// The sinks: the kitchen-type ones (kitchen, bar / prep, laundry, outdoor) and
// the bathroom ones (porcelain).
export const SINK_CATEGORIES = ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink', 'bathroom_sink'];

/**
 * Only a sink has a Craftsmanship (user, 2026-11-22: "solo los sinks de cocina
 * y los porcelain sinks traen el craftsmanship, lo demás no lo trae"). A
 * faucet or an accessory has none: the PIM neither shows, asks for nor imports
 * it there, and a marketplace that asks is given its own word for "none".
 */
export const hasCraftsmanship = (category) => SINK_CATEGORIES.includes(String(category ?? ''));

/**
 * A vessel sink: a bathroom sink that stands on the countertop. It is told by
 * its mounting ("Vessel" on the 14 of 2026-11-27, whose Installation Type reads
 * "Top Mount"); the product type or the title speak only where no mounting is
 * stored — P-210H is a drop-in filed as a "Vessel Porcelain Sink".
 */
export function isVesselSink(product) {
  if (product?.category !== 'bathroom_sink') return false;
  const a = product?.attributes ?? {};
  const mount = String(a.mounting_type ?? '').trim();
  if (mount) return /vessel/i.test(mount);
  return /vessel/i.test(`${product?.product_type ?? ''} ${a.general_title_en ?? ''}`);
}

/**
 * A vessel sink has no countertop cut-out (user, 2026-11-27): it sits on the
 * counter and needs only the opening for its drain, unlike an undermount or a
 * drop-in sink. The PIM neither shows, asks for nor imports Cut-out Dimensions
 * there, and its own Excel leaves those cells empty.
 */
export const hasCutOut = (product) => !isVesselSink(product);

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
