-- ShipStation's inventory list omits SKUs whose stock is 0 (seen 2026-09-25:
-- C430L had 1 unit, sold it, and vanished from /v2/inventory altogether).
-- So a SKU we already tracked that is missing from a pull most likely sold
-- out — the pull now keeps its row at 0 and stamps dropped_at instead of
-- deleting it. It clears again the moment the SKU is back in the list.
-- A SKU that NEVER had a row stays "not tracked".
--
-- APPLIED live 2026-09-25 via the management API; this file documents it.

alter table public.product_inventory
  add column if not exists dropped_at timestamptz;
