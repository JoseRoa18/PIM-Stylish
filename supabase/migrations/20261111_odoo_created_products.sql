-- Products the PIM created in Odoo (user, 2026-11-11: "¿y si al crear un
-- producto nuevo en PIM que se cree en Odoo de una vez?" — yes, with a
-- "Create it in Odoo too" box on the new product).
--
-- One row per SKU the odoo-push edge function created there: the Odoo ids,
-- the name it was given and who asked. It is what tells the function which
-- Odoo products take their Name from the PIM's General Title afterwards
-- (user: "el Odoo description será el general title de nosotros") — a product
-- Odoo already had keeps the name it has.
--
-- Written only by the edge function (service role); everyone signed in reads.

create table if not exists public.odoo_created_products (
  sku               text primary key references public.products(sku) on update cascade on delete cascade,
  odoo_template_id  integer not null,
  odoo_product_id   integer,
  name_sent         text,
  created_by        uuid,
  created_by_email  text,
  created_at        timestamptz not null default now()
);

comment on table public.odoo_created_products is
  'Products the PIM created in Odoo (odoo-push, create: true). Their Odoo Name follows the PIM''s General Title.';

alter table public.odoo_created_products enable row level security;

drop policy if exists odoo_created_products_select on public.odoo_created_products;
create policy odoo_created_products_select
  on public.odoo_created_products for select
  to authenticated
  using (true);
