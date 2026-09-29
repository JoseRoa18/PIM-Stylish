-- The PIM only carries two brands (user rule 2026-09-29): Stylish and Azuni.
-- Every brand input in the app is a dropdown of src/features/products/lib/
-- brands.js and imports map any casing onto them; this keeps scripts and
-- anything else from writing a third spelling. The brand picks the general
-- warranty (20260929_brand_warranty.sql) and the Wix stores that sell it.
-- A new brand needs this constraint AND brands.js updated.
alter table public.products drop constraint if exists products_brand_check;
alter table public.products
  add constraint products_brand_check check (brand in ('Stylish', 'Azuni'));
