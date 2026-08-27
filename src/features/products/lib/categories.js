// Single source of truth for the product-category options (mirrors the
// product_category enum in the database). Add new categories here AND via a
// migration that alters the enum — the DB must know the value first.
export const CATEGORY_OPTIONS = [
  { value: 'kitchen_sink', label: 'Kitchen Sink' },
  { value: 'bathroom_sink', label: 'Bathroom Sink' },
  { value: 'kitchen_faucet', label: 'Kitchen Faucet' },
  { value: 'bathroom_faucet', label: 'Bathroom Faucet' },
  { value: 'pot_filler', label: 'Pot Filler' },
  { value: 'bar_prep_sink', label: 'Bar/Prep Sink' },
  { value: 'laundry_sink', label: 'Laundry Sink' },
  { value: 'outdoor_sink', label: 'Outdoor Sink & Ice Chest' },
  { value: 'colander_drying_rack', label: 'Colanders & Drying Racks' },
  { value: 'accessory', label: 'Accessory' },
];
