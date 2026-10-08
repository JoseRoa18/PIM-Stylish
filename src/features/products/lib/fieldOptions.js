// Fixed value lists for the product page's dropdowns (user request 2026-10-06:
// a dropdown wherever the value comes from a known list, so nobody types a
// typo). Each list holds the values the catalog and the exporters already use.
// A stored value that is not on its list still shows as the first option, so
// opening Edit never drops it; it only changes when someone picks another one.
//
// Fields whose values are open (series, product type, finish…) are not here:
// they use the catalog's own values plus "Other…" (`suggest` in ProductDetail).

export const YES_NO_OPTIONS = ['Yes', 'No'];
export const YES_NO_DNA_OPTIONS = ['Yes', 'No', 'Does Not Apply'];
// Certification / compliance answers as the marketplace sheets word them.
// Both "Does Not Apply" and "Not Applicable" are in use (the sink and the
// faucet sheets differ); isYes() reads every one of them as "no".
export const COMPLIANCE_OPTIONS = ['Yes', 'No', 'Not Certified', 'Does Not Apply', 'Not Applicable'];

export const MANUFACTURER_OPTIONS = ['Stylish International Inc.', 'Azuni'];

// Color and Finish Type split the PIM's Finish ("Matte Black") into the plain
// color and the kind of surface (user's product data file, 2026-10-08). The
// Finish itself stays as it is.
export const COLOR_OPTIONS = [
  'Black', 'White', 'Gray', 'Dark Gray', 'Silver', 'Stainless Steel', 'Chrome', 'Gold',
  'Graphite Black', 'Gunmetal', 'Brown', 'Red', 'Black and Gold', 'Black and Silver', 'Mixed',
];
export const FINISH_TYPE_OPTIONS = ['Brushed', 'Matte', 'Glossy', 'Polished', 'Honey-toned', 'Dura-Tek'];
// Wayfair always gets "Limited"; Amazon's Warranty Type reads this field.
export const WARRANTY_OPTIONS = ['Limited', 'Full Warranty'];
// Matches Wayfair's "Warranty Length" valid values (used in exports).
export const WARRANTY_LENGTH_OPTIONS = [
  '30 Days', '60 Days', '90 Days', '6 Months', '18 Months',
  '1 Year', '2 Years', '3 Years', '4 Years', '5 Years', '6 Years', '7 Years',
  '8 Years', '10 Years', '12 Years', '15 Years', '20 Years', '25 Years',
  'Lifetime', 'Warranty length varies by part',
];

// Wayfair exports "Poured / Molded" with its own spelling ("Moulded").
export const CRAFTSMANSHIP_OPTIONS = ['No Craftsmanship', 'Handmade', 'Poured / Molded', 'Pressmade'];
export const SINK_SHAPE_OPTIONS = ['Rectangular', 'Square', 'Round', 'Oval'];
// Sink installation is a single choice — dual mount is its own option, not
// a pair of values (drives the per-type installation manual slots).
export const INSTALLATION_TYPE_OPTIONS = ['Undermount', 'Drop-In', 'Dual Mount', 'Top Mount'];
export const GAUGE_OPTIONS = ['16', '18'];
export const BOWL_CONFIGURATION_OPTIONS = ['Single Bowl', 'Double Bowl'];
export const BASIN_SPLIT_OPTIONS = ['50/50', '60/40', '70/30'];
export const DRAIN_LOCATION_OPTIONS = ['Center', 'Rear', 'Rear Center', 'Side Drain / Reversible', 'Center Drain / Reversible'];

// Wayfair's "Overall Shape" vocabulary for faucet classes (Product Addition
// questions, read 2026-09-15). The faucet-relevant ones lead the list.
export const FAUCET_SHAPE_OPTIONS = [
  'Gooseneck / High Arc', 'Straight', 'Curved', 'Arch',
  'Rectangle', 'Square', 'Triangle', 'Cylinder', 'Wedge', 'Oval', 'Round', 'Hexagon', 'T-Shaped',
  'Free Form', 'Novelty', 'L-Shaped', 'Diamond', 'Circle', 'U-Shaped', 'Abstract', 'Cube', 'Concave',
  'Flat', 'Elongated', 'Random', 'Crescent', 'Unique', 'Rounded Back', 'Can', 'P-Shaped', 'Unavailable',
];
// Wayfair's "Spout Type" vocabulary (Kitchen Faucets 653 requires it, Bathroom
// Sink Faucets 655 recommends it; read 2026-09-21). Same six values in both.
export const SPOUT_TYPE_OPTIONS = ['Gooseneck / High Arc', 'Low Arc', 'Rigid / Fixed', 'Swivel', 'Swing', 'Spring Neck'];
// What the exporters recognise: Wayfair's Construction Features (pull down /
// pull out), Best Buy / BB&B handle styles (lever / knob / cross).
export const SPRAY_TYPE_OPTIONS = ['Pull Down', 'Pull Out', 'Standard Faucet', 'Pot Filler', 'Does Not Apply'];
export const SPRAY_ACTIVATION_OPTIONS = ['Spray Head Button', 'Lever', 'Does Not Apply'];
export const HANDLE_STYLE_OPTIONS = ['Lever', 'Knob', 'Cross'];

// Product types whose SKUs other products point at (Strainer Model,
// Compatible Deck Plate #, Compatible Drain Assembly #).
export const STRAINER_TYPE = 'Strainer';
export const DECK_PLATE_TYPE = 'Deck Plates';
export const DRAIN_TYPE = 'Mushroom';

/**
 * The SKUs of one product type, of the product's own brand only: a Stylish
 * sink is offered Stylish strainers (ST-03), an Azuni one Azuni strainers
 * (ST03) — with and without the dash they are different brands. When the
 * brand has none of that type, every brand's SKUs are offered.
 */
export function skusOfType(suggestions, productType, brand) {
  const all = suggestions?.skusByType?.[productType] ?? [];
  const own = all.filter((r) => r.brand === brand);
  return (own.length ? own : all).map((r) => r.sku);
}
