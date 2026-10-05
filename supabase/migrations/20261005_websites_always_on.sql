-- The Sinks Direct and Stylish websites carry EVERY product (user rule
-- 2026-10-05: "ningún producto puede estar excluido de allí, todos deben
-- estar en esos websites"). Their exclusion keys can never be stored in
-- products.channel_exclusions — whoever writes them (the product page, a
-- bulk edit, a script): the trigger drops them, the other marketplaces'
-- exclusions are kept as they are. The keys already stored (343 / 46 / 6 / 6,
-- most from a bulk change of 2026-09-23) were removed the same day.

create or replace function public.products_websites_always_on()
returns trigger language plpgsql as $$
begin
  if new.channel_exclusions && array['wix_sinksdirect_ca', 'wix_sinksdirect_us', 'wix_stylish_ca', 'wix_stylish_us'] then
    new.channel_exclusions := array(
      select k from unnest(new.channel_exclusions) with ordinality as x(k, i)
      where k <> all (array['wix_sinksdirect_ca', 'wix_sinksdirect_us', 'wix_stylish_ca', 'wix_stylish_us'])
      order by i);
  end if;
  return new;
end $$;

drop trigger if exists products_websites_always_on on public.products;
create trigger products_websites_always_on
  before insert or update of channel_exclusions on public.products
  for each row execute function public.products_websites_always_on();
