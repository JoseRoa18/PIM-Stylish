-- A UPC must be well formed to be saved (user, 2026-11-11: "¿podemos meterle
-- una validación a los UPC?" — format and check digit, and it "no deja
-- guardar").
--
-- Whoever writes attributes.upc — the product page, a spreadsheet import, a
-- script — the database refuses a UPC that is not 12 digits (UPC-A, what all
-- 376 UPCs of the catalog are that day) with the right check digit, and says
-- which of the three it is. The check digit catches a number typed wrong,
-- left out or added; the message never says which digit "should" be there,
-- since correcting the last digit of a mistyped UPC makes a valid UPC that is
-- not the product's.
--
-- Like the one-product rule (products_unique_upc), only a UPC that is being
-- set or changed is checked, and an empty UPC is no UPC. Spaces around the
-- value (a cell or a paste) are removed, nothing else is changed: spaces or
-- dashes inside are refused, not cleaned.
--
-- The browser applies the same rule before it writes (upcProblem in
-- src/features/import/lib/upcCheck.js: the product page's field and the
-- import preview). Change the rule here, never only in the browser.

-- NULL when the UPC is fine (or empty), else what is wrong with it.
create or replace function public.upc_problem(value text)
returns text language plpgsql immutable as $$
declare
  v text := regexp_replace(coalesce(value, ''), '^[\s ]+|[\s ]+$', '', 'g');
  total int := 0;
  i int;
begin
  if v = '' then return null; end if;
  if v !~ '^[0-9]+$' then return 'it must be numbers only (no spaces, dashes or letters)'; end if;
  if length(v) <> 12 then return format('it has %s digits and a UPC has 12', length(v)); end if;
  -- UPC-A: the 1st, 3rd … 11th digits count three times
  for i in 1..11 loop
    total := total + substr(v, i, 1)::int * (case when i % 2 = 1 then 3 else 1 end);
  end loop;
  if (10 - total % 10) % 10 <> substr(v, 12, 1)::int then
    return 'its last digit (the check digit) does not match the other 11, so one of its numbers is wrong';
  end if;
  return null;
end $$;

create or replace function public.products_valid_upc()
returns trigger language plpgsql as $$
declare
  raw text := new.attributes ->> 'upc';
  clean text;
  problem text;
begin
  if raw is null then return new; end if;
  clean := regexp_replace(raw, '^[\s ]+|[\s ]+$', '', 'g');
  if clean = '' then return new; end if;
  -- only a UPC that is being set or changed
  if tg_op = 'UPDATE' and clean is not distinct from regexp_replace(coalesce(old.attributes ->> 'upc', ''), '^[\s ]+|[\s ]+$', '', 'g') then
    return new;
  end if;
  problem := public.upc_problem(clean);
  if problem is not null then
    raise exception 'UPC % is not valid: %.', clean, problem;
  end if;
  if clean is distinct from raw then
    new.attributes := jsonb_set(new.attributes, '{upc}', to_jsonb(clean));
  end if;
  return new;
end $$;

drop trigger if exists products_valid_upc on public.products;
create trigger products_valid_upc
  before insert or update of attributes on public.products
  for each row execute function public.products_valid_upc();
