-- An Azuni product is made by Azuni (user rule 2026-10-06: "Si Brand es
-- Azuni, manufacturer no puede ser Stylish, debe ser Azuni igualmente").
-- Whoever writes the product (the product page, an import, a bulk edit, a
-- script), an Azuni product's attributes.manufacturer is "Azuni"; Stylish
-- products keep what they have. The 4 Azuni products with another value or
-- none (C234L "Stylish International Inc."; C133L, C136L, C236L empty) were
-- set the same day.

create or replace function public.products_azuni_manufacturer()
returns trigger language plpgsql as $$
begin
  if new.brand = 'Azuni' and (new.attributes ->> 'manufacturer') is distinct from 'Azuni' then
    new.attributes := jsonb_set(coalesce(new.attributes, '{}'::jsonb), '{manufacturer}', '"Azuni"');
  end if;
  return new;
end $$;

drop trigger if exists products_azuni_manufacturer on public.products;
create trigger products_azuni_manufacturer
  before insert or update of brand, attributes on public.products
  for each row execute function public.products_azuni_manufacturer();
