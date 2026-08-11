-- MAP (Minimum Advertised Price, CAD) — the price floor from the official
-- price list. Distinct from msrp_cad (list/retail price) and dealer_cost_cad
-- (cost of goods): channels must never ADVERTISE below MAP, so Listing
-- Health can compare live channel prices against it.
alter table public.products
  add column if not exists map_cad numeric;

comment on column public.products.map_cad is
  'Minimum Advertised Price in CAD, from the official price list. Channels must not advertise below this.';
