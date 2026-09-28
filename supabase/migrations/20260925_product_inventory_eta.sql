-- The Canada inventory file ("Stylish Inventory" on SharePoint) carries an
-- "ETA CAN" column next to the quantity: when a SKU is at 0, when the next
-- stock lands. Kept as text (a date or whatever the sheet says) so the
-- product page and the promotion table can show "0 · ETA 2026-10-15".
--
-- APPLIED live 2026-09-25 via the management API; this file documents it.

alter table public.product_inventory
  add column if not exists eta text;
