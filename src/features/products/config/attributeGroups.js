/**
 * Defines how attributes (JSONB) are grouped and ordered on the
 * product detail page, per product category.
 *
 * Keys listed here are looked up in product.attributes. Any keys
 * present in attributes but NOT listed in any group will appear in
 * an "Other Attributes" section at the end (collapsed by default).
 */

export const ATTRIBUTE_GROUPS = {
  kitchen_sink: [
    {
      title: 'Bowl Configuration',
      keys: [
        'sink_shape',
        'number_of_bowls',
        'bowl_configuration',
        'basin_split',
        'low_divider',
        'has_grooves',
        'drain_hole_location',
      ],
    },
    {
      title: 'Sink Dimensions',
      keys: [
        'external_dimensions_in',
        'internal_dimensions_in',
        'sink_radius_mm',
        'drain_diameter_in',
        'product_weight_lb',
      ],
    },
    {
      title: 'Installation',
      keys: [
        'max_deck_thickness_in',
        'min_external_cabinet_size_in',
        'min_internal_cabinet_size_in',
      ],
    },
    {
      title: 'Construction',
      keys: ['craftsmanship', 'number_of_pieces', 'stackable_for_assembly'],
    },
    {
      title: 'Durability',
      keys: ['durability_tags'],
    },
    {
      title: 'Included Accessories',
      keys: [
        'accessories_included',
        'includes_grids',
        'will_sell_grids_separately',
        'grids_model_code',
        'strainer_model',
      ],
    },
    {
      title: 'Care & Maintenance',
      keys: ['care_instructions'],
      defaultOpen: false,
    },
  ],

  // Future: bathroom_sink, kitchen_faucet, bathroom_faucet, accessory
};

// Outdoor sinks / ice chests share sink anatomy — same grouping.
ATTRIBUTE_GROUPS.outdoor_sink = ATTRIBUTE_GROUPS.kitchen_sink;

export function getAttributeGroups(category) {
  return ATTRIBUTE_GROUPS[category] ?? [];
}