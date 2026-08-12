-- Promotions carry promotional COSTS per channel group besides the promo
-- price (e.g. "PROMO COST for Small Online Dealers CAD"). Channel groupings
-- vary per list, so they live in a jsonb keyed by a channel slug
-- (e.g. {"sod_cad": 166.5, "wayfair_cad": 170}) instead of fixed columns.
alter table public.promotion_prices
  add column if not exists promo_costs jsonb not null default '{}';

comment on column public.promotion_prices.promo_costs is
  'Promotional dealer costs keyed by channel-group slug (sod_cad, wayfair_cad, rona_hd_cad, lowes_sod_bbb_usd, ...).';
