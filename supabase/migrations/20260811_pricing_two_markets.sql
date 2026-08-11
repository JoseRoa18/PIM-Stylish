-- Pricing is per-market: USA (USD) and Canada (CAD), each with the three
-- levels MSRP (public list/retail) / MAP (minimum advertised) / dealer cost.
-- msrp_cad, map_cad and dealer_cost_cad already existed; this adds the USD
-- side and corrects the first MAP load, which was the US list (USD) loaded
-- into map_cad by mistake.

alter table public.products
  add column if not exists msrp_usd numeric,
  add column if not exists map_usd numeric,
  add column if not exists dealer_cost_usd numeric;

comment on column public.products.msrp_usd is 'US market list/retail price (USD).';
comment on column public.products.map_usd is 'US market Minimum Advertised Price (USD) from the official price list.';
comment on column public.products.dealer_cost_usd is 'US market dealer cost (USD).';
comment on column public.products.map_cad is 'Canadian market Minimum Advertised Price (CAD) from the official price list.';

-- One-time fix: the 2026-08-11 load put the US MAP list into map_cad.
update public.products
   set map_usd = map_cad,
       map_cad = null
 where map_cad is not null
   and map_usd is null;
