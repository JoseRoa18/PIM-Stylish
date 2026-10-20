-- What the Where to Buy check reads on a store's product page, besides OK /
-- Broken (user, 2026-10-20: "que apunte al producto correcto por SKU" and
-- "traer el precio para el price alignment"). It comes from the page the
-- check already opens, so it costs nothing more (_shared/pageProduct.js reads
-- each store's page):
--   page_model    the model / part number the page gives its product ("S-611W")
--   page_item_id  the store's own id of it (Home Depot internet #, Lowe's item #…)
--   sku_check     match    the page shows this SKU
--                 variant  another option of the same product (a PIM SKU of the
--                          same family — A-801N for A-801B —, or the listing's
--                          default option when the link selects none): the
--                          link stays and should be fixed
--                 other    another product — twice in a row makes the link Broken
--                 unknown  the page names no model the PIM can place
--   page_note     what changes the meaning of the price or the link: a coupon or a
--                 discount taken in the cart, an open-box listing, a price shown
--                 only in the cart, a link that selects no option of the listing
--   price         what a shopper pays now; was_price the regular price next to a sale
--   currency      CAD / USD as the page says it; in_stock when the page says it
--   read_at       when the page was read (a check without an answer keeps the last reading)
-- Price Alignment reads them for the stores without an API (Wayfair, Amazon,
-- Home Depot, Rona, Lowe's, Menards, BB&B, Overstock and the dealers).

alter table public.where_to_buy_links
  add column if not exists page_model text,
  add column if not exists page_item_id text,
  add column if not exists sku_check text,
  add column if not exists page_note text,
  add column if not exists price numeric(12, 2),
  add column if not exists was_price numeric(12, 2),
  add column if not exists currency text,
  add column if not exists in_stock boolean,
  add column if not exists read_at timestamptz,
  -- When the link's last soft sign counted: the next one counts only that
  -- far apart (two days; Menards 6 h), and the count starts over after a week.
  add column if not exists signal_at timestamptz;

create index if not exists where_to_buy_links_reads_idx
  on public.where_to_buy_links (retailer, sku) where read_at is not null;

-- What Price Alignment reads (priceAlignment.js pageReadings): ONE row per
-- store and product — both Stylish sites carry the same link, the newest
-- reading wins — for the links already read and the broken ones (not on the
-- store). Half the rows of the table, read by the browser under its own RLS.
create or replace view public.where_to_buy_readings
  with (security_invoker = true) as
select distinct on (retailer, sku)
       retailer, sku, url, verdict, sku_check, page_model, page_note, price, currency, in_stock, read_at
  from public.where_to_buy_links
 where url is not null and (read_at is not null or verdict = 'broken')
 order by retailer, sku, read_at desc nulls last;

grant select on public.where_to_buy_readings to authenticated;
