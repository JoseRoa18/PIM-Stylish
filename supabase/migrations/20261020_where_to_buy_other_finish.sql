-- "Other finish" (user, 2026-10-20: many Wayfair.ca links flagged "Wrong
-- product" are "realmente están bien"). A link that opens the RIGHT
-- multi-option listing but chooses no option — Wayfair without ?piid= — lands
-- on the listing's default option: Wayfair's server preselects it (h1 part #,
-- photo, price, swatch), and the product's own finish is one click away
-- (A-801B's link opens TKJS1134 on A-801N Matte Black at C$30.99; with
-- ?piid=50342681 it opens A-801B Brushed Nickel at C$27.00 — checked on 16
-- pages from Canadian exits). Such a reading is sku_check 'listing'
-- (_shared/pageProduct.js skuCheck): it stays on the Stylish websites
-- (isHiddenLink hides only broken / variant / other), shows as "Other
-- finish", Price Alignment leaves its price out (it is the default's), and its
-- suggestion — the option's own address — has the reason 'other_finish'.
-- Still "Wrong product" (variant): a ?piid= the listing no longer has, a
-- single-option listing of a sibling, a default of a known other family.
-- The readings flagged before the change were moved to 'listing' the same day
-- (no ?piid= in the link, other options on the page, families not known to
-- differ) and their products' pages republished. APPLIED 2026-10-20.

alter table public.where_to_buy_suggestions drop constraint if exists where_to_buy_suggestions_reason_check;
alter table public.where_to_buy_suggestions add constraint where_to_buy_suggestions_reason_check
  check (reason in ('wrong_link', 'broken_link', 'missing', 'other_finish'));
