-- What a marketplace template is FOR. Marketplaces now ship separate files
-- to list a new product, update a listed one, change prices, or load
-- promotions; the export flow asks which one the person wants.
alter table public.marketplace_templates
  add column if not exists purpose text not null default 'new_listing';
alter table public.marketplace_templates
  drop constraint if exists marketplace_templates_purpose_check;
alter table public.marketplace_templates
  add constraint marketplace_templates_purpose_check
  check (purpose in ('new_listing', 'update', 'prices', 'promotions'));
