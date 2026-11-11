-- A UPC can be on one product only (user, 2026-11-11: "que no se pueda
-- repetir un UPC en ningún producto").
--
-- Whoever writes attributes.upc — the product page, a spreadsheet import, a
-- script — the database refuses a UPC another product already has and names
-- that product. Two UPCs are the same when their digits are the same, leading
-- zeros aside (840994001412 = 0840994001412, its EAN-13 / GTIN-14 spelling).
-- An empty UPC is never a repeat.
--
-- Only a UPC that is being set or changed is checked. The one pair stored
-- before the rule — D-700C2 and D-701C2, both 840994004963; the user decides
-- which is right — can therefore still be saved until it is fixed, and nobody
-- else can take that UPC. Two products can't swap their UPCs in one go: empty
-- one first.
--
-- The same day the placeholder 840994000000 came off the six kits that shared
-- it (S-828WHK / WLK / WNK, S-831WHK / WLK / WNK — user: "vamos a quitarle el
-- UPC y que aparezca como faltante"): they have no UPC of their own yet.

create or replace function public.upc_key(value text)
returns text language sql immutable as $$
  select nullif(ltrim(regexp_replace(coalesce(value, ''), '\D', '', 'g'), '0'), '')
$$;

-- security definer: the check must see every product, whatever the caller's
-- row policies let them read.
create or replace function public.products_unique_upc()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  k text := public.upc_key(new.attributes ->> 'upc');
  holders text;
begin
  if k is null then return new; end if;
  if tg_op = 'UPDATE' and k is not distinct from public.upc_key(old.attributes ->> 'upc') then
    return new;
  end if;
  -- two saves of the same UPC at once: the second waits for the first
  perform pg_advisory_xact_lock(hashtextextended('products.upc:' || k, 0));
  select string_agg(p.sku, ', ' order by p.sku) into holders
    from public.products p
   where p.sku <> new.sku
     and public.upc_key(p.attributes ->> 'upc') = k;
  if holders is not null then
    raise exception 'UPC % is already on %. A UPC can be on one product only.',
      btrim(new.attributes ->> 'upc'), holders;
  end if;
  return new;
end $$;

drop trigger if exists products_unique_upc on public.products;
create trigger products_unique_upc
  before insert or update of attributes on public.products
  for each row execute function public.products_unique_upc();

update public.products
   set attributes = attributes - 'upc'
 where attributes ->> 'upc' = '840994000000';
