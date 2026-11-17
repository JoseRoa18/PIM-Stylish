-- A template can be for a marketplace's MK events only (user, 2026-11-17:
-- Walmart Canada's new deal file — SKU, Promo Price, Flash Deal Type —
-- "aplícalo solo para MK Events"). An MK event is filled from such a file
-- when the marketplace has one, else from its "Flash deals & events" file;
-- flash deals and peak season events never use it (promoTemplatesFor in
-- src/features/pricing/lib/promoChannels.js).
alter table public.marketplace_templates
  drop constraint if exists marketplace_templates_purpose_check;
alter table public.marketplace_templates
  add constraint marketplace_templates_purpose_check
  check (purpose in ('new_listing', 'update', 'prices', 'promotions', 'flash_deals', 'mk_events'));
