-- Promotion prices ARE the products' price levels (user rule 2026-09-28:
-- "todo debe ser con lo que tienen los productos en Pricing"). A promotion
-- is a SKU list with a kind; promotion_prices caches, per member, the level
-- that kind runs at — monthly promotions and flash deals the Orange level,
-- special events the Purple one — so every channel (Wix, Best Buy, Walmart,
-- the marketplace files) reads one truth. Two triggers keep it so:
--   · rows are computed from the product when they are written, whatever
--     prices came with them (pasted lists and price files only contribute
--     their SKUs);
--   · when a product's level prices change in Pricing, its rows in draft and
--     active promotions are refreshed (ended promotions stay as history).
-- The one value the levels do not carry is Wayfair Canada's base cost
-- (promo_costs.wayfair_ca_usd, no product column): it stays as loaded.
--
-- APPLIED live 2026-09-28 via the management API; this file documents it.

create or replace function public.promotion_level_of(kind text)
returns text language sql immutable as $$
  select case when kind = 'special' then 'purple' else 'orange' end
$$;

-- The row values a product gives a promotion of that kind.
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
      'menards_usd',       case when public.promotion_level_of(kind) = 'purple' then p.cost_usd_menards_purple       else p.cost_usd_menards_orange       end
    ))
$$;

-- Every write to promotion_prices ends up carrying the level values; the
-- cost slugs the levels do not know (wayfair_ca_usd) are kept as written.
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
  new.promo_costs := (coalesce(new.promo_costs, '{}'::jsonb) - array['rona_hd_cad', 'sod_cad', 'lowes_sod_bbb_usd', 'wayfair_usd', 'menards_usd'])
                     || coalesce(v.promo_costs, '{}'::jsonb);
  return new;
end $$;

drop trigger if exists promotion_prices_from_level on public.promotion_prices;
create trigger promotion_prices_from_level
  before insert or update on public.promotion_prices
  for each row execute function public.promotion_prices_from_level();

-- A level price changed in Pricing: refresh the product's rows in the
-- promotions that are not over (the row trigger above recomputes them).
create or replace function public.refresh_promotion_prices_of_product()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.promotion_prices x set sku = x.sku
  from public.promotions pr
  where x.promotion_id = pr.id and x.sku = new.sku and pr.status in ('draft', 'active');
  return null;
end $$;

drop trigger if exists products_refresh_promotion_prices on public.products;
create trigger products_refresh_promotion_prices
  after update of map_orange_cad, map_orange_usd, map_purple_cad, map_purple_usd,
    cost_cad_rona_hd_orange, cost_cad_rona_hd_purple, cost_cad_wayfair_sod_orange, cost_cad_wayfair_sod_purple,
    cost_usd_lowes_sod_bbb_orange, cost_usd_lowes_sod_bbb_purple, cost_usd_wayfair_orange, cost_usd_wayfair_purple,
    cost_usd_menards_orange, cost_usd_menards_purple
  on public.products
  for each row execute function public.refresh_promotion_prices_of_product();

-- Re-derive a whole promotion by hand (returns the rows touched).
create or replace function public.refresh_promotion_prices(pid bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.promotion_prices set sku = sku where promotion_id = pid;
  get diagnostics n = row_count;
  return n;
end $$;
