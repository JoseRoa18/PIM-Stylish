-- Every Azuni product is always on the Azuni store, never on the Stylish
-- stores; every Stylish product is always on the Stylish stores, never on the
-- Azuni store (user, 2026-11-04). The "never" half is the brand rule
-- (wixSiteSells / siteSells: Stylish sites exclude Azuni, the Azuni site
-- takes only Azuni). The "always" half: like the Sinks Direct and Stylish
-- websites (20261005_websites_always_on.sql), the Azuni store's exclusion key
-- can never be stored — the trigger drops it whoever writes it.
--
-- Stored before: 328 products (327 Stylish — moot, the brand rule keeps them
-- off that store — and one Azuni product, C234L, now back on its store).

create or replace function public.products_websites_always_on()
returns trigger language plpgsql as $$
begin
  if new.channel_exclusions && array['wix_sinksdirect_ca', 'wix_sinksdirect_us', 'wix_stylish_ca', 'wix_stylish_us', 'wix_azuni_ca'] then
    new.channel_exclusions := array(
      select k from unnest(new.channel_exclusions) with ordinality as x(k, i)
      where k <> all (array['wix_sinksdirect_ca', 'wix_sinksdirect_us', 'wix_stylish_ca', 'wix_stylish_us', 'wix_azuni_ca'])
      order by i);
  end if;
  return new;
end $$;

update public.products
   set channel_exclusions = array_remove(channel_exclusions, 'wix_azuni_ca')
 where channel_exclusions @> array['wix_azuni_ca'];
