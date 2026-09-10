-- Wayfair USA supplier (36896) listing ids live apart from the Canadian ones.
alter table public.products add column if not exists wayfair_usa_item_group_id text;
