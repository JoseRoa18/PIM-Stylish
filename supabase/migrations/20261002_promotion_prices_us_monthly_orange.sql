-- Monthly promotion prices by market (user rule 2026-10-02, refining
-- 20260930_promotion_prices_file_first):
--   · Canada: what the FILE says goes over the Orange price; a product the
--     file gives no price takes Orange automatically.
--   · USA: the ORANGE price goes first ("en USA sí se prioriza el precio
--     orange"); a file price only fills a product without an Orange price.
--     USA costs follow the Orange level the same way (the Wayfair USA and
--     Menards files already take the level's WC).
--   · Flash deals and special events are unchanged for now ("después vemos"):
--     file first, else their level (flash Orange, special Purple; BB&B /
--     Overstock take flash deals at Purple in their files).
-- Only promotion_prices_from_level() changes; rows are recomputed by the
-- trigger the next time they are written.

CREATE OR REPLACE FUNCTION public.promotion_prices_from_level()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
  -- Monthly promotions (user rule 2026-10-02): Canada takes the file's
  -- price over the Orange level (no price in the file -> Orange); the USA
  -- takes the Orange level over the file (the file only fills a level the
  -- product lacks) -- costs the same way, market by market. Flash deals and
  -- special events keep the file first, then their level.
  if coalesce(k, 'monthly') = 'monthly' then
    new.promo_price_usd := case when new.in_us then coalesce(v.promo_price_usd, new.set_price_usd) end;
    costs := (coalesce(v.promo_costs, '{}'::jsonb) - us_slugs) || (new.set_costs - us_slugs)
          || (new.set_costs - ca_slugs) || (coalesce(v.promo_costs, '{}'::jsonb) - ca_slugs);
  else
    new.promo_price_usd := case when new.in_us then coalesce(new.set_price_usd, v.promo_price_usd) end;
    costs := coalesce(v.promo_costs, '{}'::jsonb) || new.set_costs;
  end if;
  if not coalesce(new.in_ca, false) then costs := costs - ca_slugs; end if;
  if not coalesce(new.in_us, false) then costs := costs - us_slugs; end if;
  new.promo_costs := costs;
  return new;
end $function$;
