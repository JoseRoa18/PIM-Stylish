-- A product's prices must make sense to be saved (user, 2026-11-11: "hay que
-- meter validaciones en el módulo de pricing … hazlas todas").
--
-- Whoever writes them — the product page's Pricing tab, a spreadsheet import,
-- a script — the database refuses:
--   · a price or a cost of 0 or less (an empty one is no price);
--   · an Orange or a Purple MAP above the Blue MAP of its table (Canada CAD,
--     USA USD, Wayfair Canada USD): a promotion level cannot be above the
--     regular price;
--   · a cost (WC) that is not under the MAP of its own level.
-- Checked that day on every product, archived ones included: none breaks any
-- of them.
--
-- Like the UPC rules, only what is being set or changed is checked: a rule
-- fires on an update when one of the columns it compares changes, so a product
-- can always be saved for something else. The columns are numeric, so a value
-- that is no number never reaches this.
--
-- The browser applies the same rules in the same words before it writes
-- (priceProblems in src/features/products/lib/priceRules.js: the product page
-- and the import preview). Change the rule here, never only in the browser.

-- NULL when the prices of `n` (a products row as jsonb) are fine, else the
-- first thing that is wrong with them. `o` = the row before an update: only
-- the rules that involve a changed column are checked; NULL = a new row.
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
     "costs": [["cost_usd_wayfair_ca%s", "WC Wayfair Canada USD"]]}
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

create or replace function public.products_valid_prices()
returns trigger language plpgsql as $$
declare
  problem text;
begin
  problem := public.price_problem(to_jsonb(new), case when tg_op = 'UPDATE' then to_jsonb(old) end);
  if problem is not null then
    raise exception '%', problem;
  end if;
  return new;
end $$;

-- An update fires it only when the statement sets a price column.
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
    cost_usd_wayfair_ca, cost_usd_wayfair_ca_orange, cost_usd_wayfair_ca_purple
  on public.products
  for each row execute function public.products_valid_prices();
