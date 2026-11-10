-- The stock now comes from Odoo (user, 2026-11-10: "quitar eso y cambiar de
-- dónde viene la información. Ahora vendrá de Odoo … de la columna llamada
-- Available for Use").
--
-- product_inventory stays the cache every reader uses, written only by the
-- `inventory-pull` edge function, which now reads both markets from Odoo's
-- Calculated Inventory (Inventory → Reporting), column "Available for Use" =
-- Free to Use (Finished) + Max Buildable Qty from components, with one
-- warehouse selected per market (the user's choice the same day):
--   ca  warehouse CBG (Cambridge)
--   us  warehouse ATL (Flowery Branch GA)
-- Until then the USA came from ShipStation Inventory and Canada from the
-- "Stylish Inventory" Excel (daily email / Settings upload).
--
-- Nothing changes in the table's shape. `available` = Available for Use,
-- `on_hand` = Odoo's Quantity On Hand, `warehouses` = { "<code>": { on_hand,
-- available, free, buildable, incoming } }, `source` = 'odoo'; `eta` and
-- `dropped_at` (a ShipStation notion) stay NULL. A PIM product Odoo does not
-- have has no row: not tracked, which is not 0.
--
-- The hourly cron `inventory-pull-hourly` (:20) and the pull after a product
-- insert are unchanged: the function reads Odoo on every call.

alter table public.product_inventory alter column source set default 'odoo';

comment on table public.product_inventory is
  'Stock per market and SKU, a cache of Odoo''s Calculated Inventory ("Available for Use"; ca = warehouse CBG, us = warehouse ATL) written by the inventory-pull edge function. No row = Odoo does not have the product: not tracked, not 0.';
comment on column public.product_inventory.available is 'Odoo''s Available for Use in the market''s warehouse: free finished units + what can be built from components (whole units, never below 0).';
comment on column public.product_inventory.on_hand is 'Odoo''s Quantity On Hand in the market''s warehouse.';
comment on column public.product_inventory.warehouses is '{ "<warehouse code>": { "on_hand", "available", "free", "buildable", "incoming" } }';
