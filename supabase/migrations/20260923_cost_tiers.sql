-- Channel cost tiers (pricing strategy, 2026-09-23): the existing cost
-- columns are the Blue (base) costs; Orange = monthly-promotion cost,
-- Purple = flash deal / special event cost, per channel and market.
alter table public.products
  add column if not exists cost_cad_rona_hd_orange numeric(10,2),
  add column if not exists cost_cad_rona_hd_purple numeric(10,2),
  add column if not exists cost_cad_wayfair_sod_orange numeric(10,2),
  add column if not exists cost_cad_wayfair_sod_purple numeric(10,2),
  add column if not exists cost_usd_lowes_sod_bbb_orange numeric(10,2),
  add column if not exists cost_usd_lowes_sod_bbb_purple numeric(10,2),
  add column if not exists cost_usd_wayfair_orange numeric(10,2),
  add column if not exists cost_usd_wayfair_purple numeric(10,2),
  add column if not exists cost_usd_menards_orange numeric(10,2),
  add column if not exists cost_usd_menards_purple numeric(10,2);
