-- Canadian pricing per the official price-list structure (confirmed by the
-- user): MSRP, MAP (one list for ALL marketplaces), and two channel-group
-- costs — Rona + Home Depot, and Wayfair + Small Online Dealers.
-- dealer_cost_cad stays: 51 products carry legacy values and it is what the
-- Wix integration pushes as cost-of-goods for margin calculation.

alter table public.products
  add column if not exists cost_cad_rona_hd numeric,
  add column if not exists cost_cad_wayfair_sod numeric;

comment on column public.products.cost_cad_rona_hd is
  'Canadian dealer cost (CAD) for Rona and Home Depot.';
comment on column public.products.cost_cad_wayfair_sod is
  'Canadian dealer cost (CAD) for Wayfair and Small Online Dealers.';
comment on column public.products.map_cad is
  'Canadian Minimum Advertised Price (CAD) — one list covering all marketplaces.';
comment on column public.products.dealer_cost_cad is
  'Legacy/internal cost of goods (CAD) — pushed to Wix costAndProfitData for margin calc; not one of the official channel cost lists.';
