-- Seed S-636W with master spreadsheet data.
-- Uses ONLY existing columns + attributes JSONB.

UPDATE public.products
SET
  -- Identification (existing columns)
  model_name             = 'Versa36',
  family_number          = 14,
  brand                  = 'Stylish',
  category               = 'kitchen_sink',
  series                 = 'Versa',
  product_type           = 'Undermount Kitchen Sinks',
  material               = 'Stainless Steel',
  finish                 = 'Brushed stainless steel',

  -- Pricing
  msrp_cad               = 1660.00,
  dealer_cost_cad        = 498.00,

  -- Shipping
  shipping_weight_lb     = 57,

  -- Dates
  sample_available_date  = '2024-03-15',
  ready_to_sell_date     = '2024-05-15',

  -- Compliance
  standards_compliance   = 'cUPC Certified, UPC Certified, SCC Compliant, Vermont Act 193 Compliant',

  -- QuickBooks
  quickbooks_description = 'Ledge Sink Stainless Steel 60/40 handmade 36" x 19" x 10". R10. Includes basket strainers. Grids Cutting Board and Colander. Ledge Sink. 16 Gage. Model: Versa36',

  -- Description (HTML)
  description = '<p>This extra-large double bowl workstation sink revolutionizes the way you work in the kitchen. Inspired by professional kitchens and designed for the modern home chef, our VERSA36 workstation sink transforms your kitchen sink into a multifunctional hub for culinary creativity.</p>'
    || '<p>Crafted from durable 16-Gauge stainless steel, this sink features refined 10mm rounded corners and a seamlessly integrated ledge system. With a slim and low divider offering a 60-40 split and a generous 10" depth, it accommodates ample cookware. The special flange cut-out ensures easy faucet installation.</p>'
    || '<p>Efficient drainage is facilitated by the sloped bottom and basin grooves, while thick noise-absorbing pads contribute to a tranquil sink experience. The sink''s low, slim divider facilitates washing bulky items, and included perfect-fit grids offer dent protection and aid in maintaining cleanliness.</p>'
    || '<p>Designed and serviced in Canada, this sink is backed by the exceptional customer service of Stylish International Inc. The workstation includes seven accessories such as a metal colander, black drying rack, and black cutting board to further enhance workspace functionality.</p>'
    || '<p>Elevate your kitchen with a perfect blend of style and functionality, joining countless others who have experienced the difference of Stylish''s commitment to quality and innovation. Transform your kitchen with Stylish, where every product is crafted to support your lifestyle and bring lasting value into your home.</p>',

  -- Everything else goes into the attributes JSONB
  attributes = '{
    "number_of_bowls": 2,
    "bowl_configuration": "Double Bowl",
    "basin_split": "60/40",
    "low_divider": true,
    "gauge": "16",
    "installation_type": "Undermount",
    "craftsmanship": "Handmade",
    "strainer_model": "ST-03",
    "sink_radius_mm": 10,
    "drain_diameter_in": 3.5,
    "drain_hole_location": "Side drain / Reversible",
    "has_grooves": true,
    "includes_grids": true,
    "will_sell_grids_separately": false,
    "grids_model_code": "G-636",
    "stackable_for_assembly": false,
    "product_weight_lb": 55,
    "durability_tags": ["Scratch Resistant", "Stain Resistant", "Heat Resistant", "Fade Resistant"],
    "accessories_included": [
      "A-902DG Drying Rack",
      "A-906 Cutting Board",
      "A-02 Colander",
      "ST-03 Strainer (x2)",
      "G-636 Grid (x2)"
    ],
    "external_dimensions_in": { "length": 36, "width": 19, "depth": 10 },
    "internal_dimensions_in": { "length": 34, "width": 17, "depth": 10 },
    "cut_out_dimensions_in": { "length": 34, "width": 17, "depth": 10 },
    "min_external_cabinet_size_in": 38,
    "min_internal_cabinet_size_in": 36.5,
    "max_deck_thickness_in": 1.5,
    "shipping_dimensions_in": { "length": 41, "width": 24, "height": 13 },
    "product_box_mm": { "length": 1000, "width": 580, "height": 340 },
    "country_of_origin": "China",
    "hs_code": "7324.10.0050",
    "upc": "840994004994",
    "manufacturer": "Stylish International Inc.",
    "warranty": "Limited Lifetime Warranty",
    "bullet_points": [
      "ACCESSORIES INCLUDED: Seven accessories included, metal colander, drying rack, cutting board, grids, and luxury basket strainers.",
      "16 GAUGE STAINLESS STEEL: Thickest in the market for long lasting durability, dent, rust, and stain resistant.",
      "LOW AND SLIM DIVIDER: Easy to wash and rinse large pans and baking sheets while keeping the basins separate.",
      "60/40 LAYOUT: Ideal to keep your dirty dishes separated and keeping a large bowl free.",
      "REVERSIBLE INSTALLATION DESIGN: Place the larger bowl to your side of preference (left or right), side drain design optimizes cabinet space under the sink.",
      "REFINED CORNERS WITH BUILT-IN LEDGES: The ledge integrates the accessories to slide precisely on the sink.",
      "DEEP BOWLS: The 10 inch depth design accommodates large cookware.",
      "MORE ROOM FOR FAUCET INSTALLATION: Includes special cut-out to provide more space for faucet installation.",
      "QUALITY ASSURED: cUPC certified, meets the highest plumbing standards.",
      "SLOPED BOTTOM & BASIN GROOVES: Fast drainage. Prevents water pooling.",
      "QUIET SINK: Thick noise-absorbing rubber pads with protective coating for condensation reduction.",
      "PERFECT FIT GRIDS: Bottom Grids included to protect your sink from dents and scratches."
    ]
  }'::jsonb

WHERE sku = 'S-636W';
