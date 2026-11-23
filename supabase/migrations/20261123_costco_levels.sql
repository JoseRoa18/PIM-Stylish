-- Costco Canada's own prices, in USD (user, 2026-11-23: "para la sección de
-- pricing, debemos agregar el de Costco. Los precios de Costco van aparte, es
-- decir, tanto el MAP como el WC" — "eso es para Canadá"). His list of that
-- day, "los únicos precios que tenemos": C122, C133L, C136L, C234L, C236L —
-- C136L: MAP 488 Blue / 463.60 Purple, WC 250 Blue / 237.50 Purple, where the
-- Canada table has MAP 563 / 548 CAD.
--
-- In US dollars, like Wayfair Canada: his list's headers say "MAP Blue Base
-- USD", "WC Blue Base USD", and asked which currency, he said USD.
--
-- A table of its own: its MAP and its wholesale cost at the three levels every
-- price table has — Blue (base), Orange (monthly promotion), Purple (flash
-- deal / peak season). His list gives no Orange: a level a product does not
-- have stays empty.
--
-- Only stored and checked: no promotion, file, push or Price Alignment reads
-- these columns yet (Costco is no promotion channel in the PIM), so they are
-- not among the promotion cost slugs and do not refresh promotion rows.
--
-- APPLIED live 2026-11-23 via the management API, in two steps: the columns
-- were first made as map_cad_costco… / cost_cad_costco… (read as CAD from
-- "eso es para Canadá") and renamed the same morning, with their values, once
-- he confirmed USD. The block below gives the same result from either state.

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('map_cad_costco', 'map_usd_costco'), ('map_cad_costco_orange', 'map_usd_costco_orange'), ('map_cad_costco_purple', 'map_usd_costco_purple'),
      ('cost_cad_costco', 'cost_usd_costco'), ('cost_cad_costco_orange', 'cost_usd_costco_orange'), ('cost_cad_costco_purple', 'cost_usd_costco_purple')
    ) as t(was, now)
  loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = r.was)
       and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = r.now) then
      execute format('alter table public.products rename column %I to %I', r.was, r.now);
    end if;
  end loop;
end $$;

alter table public.products
  add column if not exists map_usd_costco numeric(10,2),
  add column if not exists map_usd_costco_orange numeric(10,2),
  add column if not exists map_usd_costco_purple numeric(10,2),
  add column if not exists cost_usd_costco numeric(10,2),
  add column if not exists cost_usd_costco_orange numeric(10,2),
  add column if not exists cost_usd_costco_purple numeric(10,2);

comment on column public.products.map_usd_costco is 'Costco Canada MAP (USD), Blue level';
comment on column public.products.map_usd_costco_orange is 'Costco Canada MAP (USD), Orange level';
comment on column public.products.map_usd_costco_purple is 'Costco Canada MAP (USD), Purple level';
comment on column public.products.cost_usd_costco is 'Costco Canada wholesale cost (USD), Blue level';
comment on column public.products.cost_usd_costco_orange is 'Costco Canada wholesale cost (USD), Orange level';
comment on column public.products.cost_usd_costco_purple is 'Costco Canada wholesale cost (USD), Purple level';

-- The price rules (20261111_products_valid_prices.sql) with Costco Canada's
-- table: more than 0, Orange and Purple never above its Blue MAP, its cost
-- under its MAP of the same level. The same rule in the same words as
-- priceProblems (supabase/functions/_shared/priceRules.js).
create or replace function public.price_problem(n jsonb, o jsonb default null)
returns text language plpgsql immutable as $$
declare
  -- one block per price table of the product page; %s = the level's suffix
  groups constant jsonb := '[
    {"map": "map%s_cad", "label": "MAP CAD", "msrp": "msrp_cad", "msrp_label": "MSRP CAD$",
     "costs": [["cost_cad_rona_hd%s", "WC Rona / Home Depot CAD"], ["cost_cad_wayfair_sod%s", "WC Small Online Dealers CAD"]]},
    {"map": "map%s_usd", "label": "MAP USD", "msrp": "msrp_usd", "msrp_label": "MSRP USD$",
     "costs": [["cost_usd_lowes_sod_bbb%s", "WC Lowe''s / HD USA / SOD / BB&B USD"], ["cost_usd_wayfair%s", "WC Wayfair USD"], ["cost_usd_menards%s", "WC Menards USD"]]},
    {"map": "map_usd_wayfair_ca%s", "label": "MAP Wayfair Canada USD",
     "costs": [["cost_usd_wayfair_ca%s", "WC Wayfair Canada USD"]]},
    {"map": "map_usd_costco%s", "label": "MAP Costco Canada USD",
     "costs": [["cost_usd_costco%s", "WC Costco Canada USD"]]}
  ]';
  levels constant jsonb := '[["", "Blue"], ["_orange", "Orange"], ["_purple", "Purple"]]';
  g jsonb;
  l jsonb;
  c jsonb;
  k text;
  k2 text;
  v numeric;
  v2 numeric;
begin
  -- 1. more than 0
  for g in select * from jsonb_array_elements(groups) loop
    if g ? 'msrp' then
      k := g ->> 'msrp';
      v := (n ->> k)::numeric;
      if v <= 0 and (o is null or v is distinct from (o ->> k)::numeric) then
        return format('%s must be more than 0 (it is %s).', g ->> 'msrp_label', trim_scale(v));
      end if;
    end if;
    for l in select * from jsonb_array_elements(levels) loop
      k := format(g ->> 'map', l ->> 0);
      v := (n ->> k)::numeric;
      if v <= 0 and (o is null or v is distinct from (o ->> k)::numeric) then
        return format('%s (%s) must be more than 0 (it is %s).', g ->> 'label', l ->> 1, trim_scale(v));
      end if;
      for c in select * from jsonb_array_elements(g -> 'costs') loop
        k := format(c ->> 0, l ->> 0);
        v := (n ->> k)::numeric;
        if v <= 0 and (o is null or v is distinct from (o ->> k)::numeric) then
          return format('%s (%s) must be more than 0 (it is %s).', c ->> 1, l ->> 1, trim_scale(v));
        end if;
      end loop;
    end loop;
  end loop;

  -- 2. Orange and Purple never above Blue
  for g in select * from jsonb_array_elements(groups) loop
    k2 := format(g ->> 'map', '');
    v2 := (n ->> k2)::numeric;
    for l in select * from jsonb_array_elements(levels) loop
      continue when l ->> 0 = '';
      k := format(g ->> 'map', l ->> 0);
      v := (n ->> k)::numeric;
      if v > v2 and (o is null or v is distinct from (o ->> k)::numeric or v2 is distinct from (o ->> k2)::numeric) then
        return format('%s (%s) is %s, above %s (Blue) %s: a promotion level cannot be above the regular price.',
          g ->> 'label', l ->> 1, trim_scale(v), g ->> 'label', trim_scale(v2));
      end if;
    end loop;
  end loop;

  -- 3. a cost under the MAP of its level
  for g in select * from jsonb_array_elements(groups) loop
    for l in select * from jsonb_array_elements(levels) loop
      k2 := format(g ->> 'map', l ->> 0);
      v2 := (n ->> k2)::numeric;
      for c in select * from jsonb_array_elements(g -> 'costs') loop
        k := format(c ->> 0, l ->> 0);
        v := (n ->> k)::numeric;
        if v >= v2 and (o is null or v is distinct from (o ->> k)::numeric or v2 is distinct from (o ->> k2)::numeric) then
          return format('%s (%s) is %s, not under %s (%s) %s: a cost must be under the MAP of its level.',
            c ->> 1, l ->> 1, trim_scale(v), g ->> 'label', l ->> 1, trim_scale(v2));
        end if;
      end loop;
    end loop;
  end loop;

  return null;
end $$;

-- An update fires it only when the statement sets a price column — Costco
-- Canada's six among them.
drop trigger if exists products_valid_prices on public.products;
create trigger products_valid_prices
  before insert or update of
    msrp_cad, map_cad, map_orange_cad, map_purple_cad,
    cost_cad_rona_hd, cost_cad_rona_hd_orange, cost_cad_rona_hd_purple,
    cost_cad_wayfair_sod, cost_cad_wayfair_sod_orange, cost_cad_wayfair_sod_purple,
    msrp_usd, map_usd, map_orange_usd, map_purple_usd,
    cost_usd_lowes_sod_bbb, cost_usd_lowes_sod_bbb_orange, cost_usd_lowes_sod_bbb_purple,
    cost_usd_wayfair, cost_usd_wayfair_orange, cost_usd_wayfair_purple,
    cost_usd_menards, cost_usd_menards_orange, cost_usd_menards_purple,
    map_usd_wayfair_ca, map_usd_wayfair_ca_orange, map_usd_wayfair_ca_purple,
    cost_usd_wayfair_ca, cost_usd_wayfair_ca_orange, cost_usd_wayfair_ca_purple,
    map_usd_costco, map_usd_costco_orange, map_usd_costco_purple,
    cost_usd_costco, cost_usd_costco_orange, cost_usd_costco_purple
  on public.products
  for each row execute function public.products_valid_prices();
