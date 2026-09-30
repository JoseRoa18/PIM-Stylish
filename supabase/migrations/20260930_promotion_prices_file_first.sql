-- Promotion prices: the FILE's prices first, and each market its own list
-- (user rules 2026-09-30, correcting 20260928_promotion_prices_from_levels):
--   · "cuando se sube un archivo debe tomarse en cuenta los precios que se le
--     colocan en dicho archivo, no el orange obligatorio" — A-02: the file
--     says promo MAP 79, the PIM had put the Orange 77.
--   · "la promo de USA y de Canadá son independientes, cada una tiene sus
--     productos" — the level trigger gave every member BOTH markets' prices,
--     so a Canada-only SKU (e.g. A-902BK) also joined the USA promotion.
--
-- A row now stores what was GIVEN and which markets it belongs to:
--   in_ca / in_us            the SKU is on that market's list
--   set_price_cad / _usd     the promo MAP the file (or a pasted list) gave
--   set_costs                the promo costs the file gave, by slug
-- and the trigger keeps the columns every reader uses as the result:
--   promo_price_cad = the given CAD price, else the level's — Canada members only
--   promo_price_usd = the given USD price, else the level's — USA members only
--   promo_costs     = the level's costs overlaid with the given ones, each
--                     market's slugs only when the SKU is on that market
-- A SKU-only list (flash deals, special events, a monthly list pasted
-- without prices) still takes everything from the level, as before; a level
-- change in Pricing still refreshes those rows (products_refresh_promotion_prices).
-- Writers that only fill promo_price_* (older code, scripts) keep working:
-- on insert those values are taken as given, and on update a changed price
-- counts as a new given value.

alter table public.promotion_prices
  add column if not exists in_ca boolean,
  add column if not exists in_us boolean,
  add column if not exists set_price_cad numeric,
  add column if not exists set_price_usd numeric,
  add column if not exists set_costs jsonb not null default '{}'::jsonb;

-- Existing rows (with the trigger off, so nothing is recomputed):
--   · ended promotions are history — their prices and costs are frozen as
--     they are now (stored as given);
--   · draft/active ones keep today's membership and follow the level until
--     their market files are imported again (the file prices and the
--     per-market lists were overwritten on 2026-09-28 and are not kept anywhere).
alter table public.promotion_prices disable trigger promotion_prices_from_level;
update public.promotion_prices x
set in_ca = x.promo_price_cad is not null,
    in_us = x.promo_price_usd is not null,
    set_price_cad = case when pr.status in ('draft', 'active') then null else x.promo_price_cad end,
    set_price_usd = case when pr.status in ('draft', 'active') then null else x.promo_price_usd end,
    set_costs = case when pr.status in ('draft', 'active') then '{}'::jsonb else coalesce(x.promo_costs, '{}'::jsonb) end
from public.promotions pr
where pr.id = x.promotion_id and x.in_ca is null;
alter table public.promotion_prices enable trigger promotion_prices_from_level;

create or replace function public.promotion_prices_from_level()
returns trigger language plpgsql as $$
declare
  k text;
  v record;
  ca_slugs text[] := array['rona_hd_cad', 'sod_cad', 'wayfair_ca_usd'];
  us_slugs text[] := array['lowes_sod_bbb_usd', 'wayfair_usd', 'menards_usd'];
  costs jsonb;
begin
  if tg_op = 'INSERT' then
    -- Older writers pass the given prices in the result columns.
    if new.set_price_cad is null and new.in_ca is null then new.set_price_cad := new.promo_price_cad; end if;
    if new.set_price_usd is null and new.in_us is null then new.set_price_usd := new.promo_price_usd; end if;
    if coalesce(new.set_costs, '{}'::jsonb) = '{}'::jsonb and new.promo_costs is not null
       and new.in_ca is null and new.in_us is null then
      new.set_costs := new.promo_costs;
    end if;
    new.set_costs := coalesce(new.set_costs, '{}'::jsonb);
    -- Without an explicit list, a market is on when the row brought its price
    -- or one of its costs.
    if new.in_ca is null then new.in_ca := new.set_price_cad is not null or new.set_costs ?| ca_slugs; end if;
    if new.in_us is null then new.in_us := new.set_price_usd is not null or new.set_costs ?| us_slugs; end if;
  else
    -- An update that writes a new result price (older writers) sets it as given.
    if new.promo_price_cad is distinct from old.promo_price_cad and new.set_price_cad is not distinct from old.set_price_cad then
      new.set_price_cad := new.promo_price_cad;
      new.in_ca := new.promo_price_cad is not null;
    end if;
    if new.promo_price_usd is distinct from old.promo_price_usd and new.set_price_usd is not distinct from old.set_price_usd then
      new.set_price_usd := new.promo_price_usd;
      new.in_us := new.promo_price_usd is not null;
    end if;
    new.set_costs := coalesce(new.set_costs, '{}'::jsonb);
  end if;

  select kind into k from public.promotions where id = new.promotion_id;
  select * into v from public.promotion_level_values((select p from public.products p where p.sku = new.sku), coalesce(k, 'monthly'));

  new.promo_price_cad := case when new.in_ca then coalesce(new.set_price_cad, v.promo_price_cad) end;
  new.promo_price_usd := case when new.in_us then coalesce(new.set_price_usd, v.promo_price_usd) end;
  costs := coalesce(v.promo_costs, '{}'::jsonb) || new.set_costs;
  if not coalesce(new.in_ca, false) then costs := costs - ca_slugs; end if;
  if not coalesce(new.in_us, false) then costs := costs - us_slugs; end if;
  new.promo_costs := costs;
  return new;
end $$;
