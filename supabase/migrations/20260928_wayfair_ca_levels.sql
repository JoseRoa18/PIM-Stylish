-- Wayfair Canada's own price levels, in USD (user list 2026-09-28): the
-- Canada supplier account on Wayfair is priced in US dollars, with its own MAP
-- and wholesale cost at the three levels — Blue (base), Orange (monthly
-- promotions and flash deals), Purple (special events; "Clearance" in the
-- user's sheet). Until now its promo base cost was the one promotion value
-- that came from a pasted price file (promo_costs.wayfair_ca_usd); from here
-- on it is derived from these columns like every other level price.
--
-- APPLIED live 2026-09-28 via the management API; this file documents it.

alter table public.products
  add column if not exists map_usd_wayfair_ca numeric(10,2),
  add column if not exists map_usd_wayfair_ca_orange numeric(10,2),
  add column if not exists map_usd_wayfair_ca_purple numeric(10,2),
  add column if not exists cost_usd_wayfair_ca numeric(10,2),
  add column if not exists cost_usd_wayfair_ca_orange numeric(10,2),
  add column if not exists cost_usd_wayfair_ca_purple numeric(10,2);

comment on column public.products.map_usd_wayfair_ca is 'Wayfair Canada MAP (USD), Blue level';
comment on column public.products.map_usd_wayfair_ca_orange is 'Wayfair Canada MAP (USD), Orange level';
comment on column public.products.map_usd_wayfair_ca_purple is 'Wayfair Canada MAP (USD), Purple level';
comment on column public.products.cost_usd_wayfair_ca is 'Wayfair Canada wholesale cost (USD), Blue level';
comment on column public.products.cost_usd_wayfair_ca_orange is 'Wayfair Canada wholesale cost (USD), Orange level';
comment on column public.products.cost_usd_wayfair_ca_purple is 'Wayfair Canada wholesale cost (USD), Purple level';

-- The row values a product gives a promotion of that kind — now with
-- Wayfair Canada's cost too.
create or replace function public.promotion_level_values(p public.products, kind text)
returns table (promo_price_cad numeric, promo_price_usd numeric, promo_costs jsonb)
language sql stable as $$
  select
    case when public.promotion_level_of(kind) = 'purple' then p.map_purple_cad else p.map_orange_cad end,
    case when public.promotion_level_of(kind) = 'purple' then p.map_purple_usd else p.map_orange_usd end,
    jsonb_strip_nulls(jsonb_build_object(
      'rona_hd_cad',       case when public.promotion_level_of(kind) = 'purple' then p.cost_cad_rona_hd_purple       else p.cost_cad_rona_hd_orange       end,
      'sod_cad',           case when public.promotion_level_of(kind) = 'purple' then p.cost_cad_wayfair_sod_purple   else p.cost_cad_wayfair_sod_orange   end,
      'lowes_sod_bbb_usd', case when public.promotion_level_of(kind) = 'purple' then p.cost_usd_lowes_sod_bbb_purple else p.cost_usd_lowes_sod_bbb_orange end,
      'wayfair_usd',       case when public.promotion_level_of(kind) = 'purple' then p.cost_usd_wayfair_purple       else p.cost_usd_wayfair_orange       end,
      'wayfair_ca_usd',    case when public.promotion_level_of(kind) = 'purple' then p.cost_usd_wayfair_ca_purple    else p.cost_usd_wayfair_ca_orange    end,
      'menards_usd',       case when public.promotion_level_of(kind) = 'purple' then p.cost_usd_menards_purple       else p.cost_usd_menards_orange       end
    ))
$$;

-- Every write to promotion_prices carries the level values; wayfair_ca_usd
-- is no longer kept from the price file (only unknown slugs would be).
create or replace function public.promotion_prices_from_level()
returns trigger language plpgsql as $$
declare
  k text;
  v record;
begin
  select kind into k from public.promotions where id = new.promotion_id;
  select * into v from public.promotion_level_values((select p from public.products p where p.sku = new.sku), coalesce(k, 'monthly'));
  new.promo_price_cad := v.promo_price_cad;
  new.promo_price_usd := v.promo_price_usd;
  new.promo_costs := (coalesce(new.promo_costs, '{}'::jsonb) - array['rona_hd_cad', 'sod_cad', 'lowes_sod_bbb_usd', 'wayfair_usd', 'wayfair_ca_usd', 'menards_usd'])
                     || coalesce(v.promo_costs, '{}'::jsonb);
  return new;
end $$;

-- A level price changed in Pricing (Wayfair Canada's included): refresh the
-- product's rows in the promotions that are not over.
drop trigger if exists products_refresh_promotion_prices on public.products;
create trigger products_refresh_promotion_prices
  after update of map_orange_cad, map_orange_usd, map_purple_cad, map_purple_usd,
    cost_cad_rona_hd_orange, cost_cad_rona_hd_purple, cost_cad_wayfair_sod_orange, cost_cad_wayfair_sod_purple,
    cost_usd_lowes_sod_bbb_orange, cost_usd_lowes_sod_bbb_purple, cost_usd_wayfair_orange, cost_usd_wayfair_purple,
    cost_usd_wayfair_ca_orange, cost_usd_wayfair_ca_purple,
    cost_usd_menards_orange, cost_usd_menards_purple
  on public.products
  for each row execute function public.refresh_promotion_prices_of_product();
