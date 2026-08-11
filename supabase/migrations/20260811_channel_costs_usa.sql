-- US costs are per channel group — three distinct price lists (confirmed by
-- the user: "Lowes, Small Online Dealers y BB&B es una. Luego Wayfair y
-- luego Menards, solo esas 3"). A single dealer_cost_usd is ambiguous, so it
-- is replaced by one column per tier before any data ever landed in it.

alter table public.products
  drop column if exists dealer_cost_usd;

alter table public.products
  add column if not exists cost_usd_lowes_sod_bbb numeric,
  add column if not exists cost_usd_wayfair numeric,
  add column if not exists cost_usd_menards numeric;

comment on column public.products.cost_usd_lowes_sod_bbb is
  'US dealer cost (USD) for Lowes, Small Online Dealers and Bed Bath & Beyond.';
comment on column public.products.cost_usd_wayfair is
  'US dealer cost (USD) for Wayfair.';
comment on column public.products.cost_usd_menards is
  'US dealer cost (USD) for Menards.';
