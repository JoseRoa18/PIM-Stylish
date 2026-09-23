-- The "Flash deals & events" purpose (added to the UI 2026-09-22) was missing
-- from the check constraint, so uploading such a template failed.
alter table public.marketplace_templates
  drop constraint if exists marketplace_templates_purpose_check;
alter table public.marketplace_templates
  add constraint marketplace_templates_purpose_check
  check (purpose in ('new_listing', 'update', 'prices', 'promotions', 'flash_deals'));
