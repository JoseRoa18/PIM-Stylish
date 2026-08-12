-- dealer_cost_cad was the pre-restructuring generic cost column, kept
-- briefly as the Wix cost-of-goods feed. The user confirmed it's unused
-- ("eso no lo usamos") — dropped in favor of the official per-channel cost
-- lists (cost_cad_rona_hd / cost_cad_wayfair_sod and the three USD ones).
-- The 51 legacy values were snapshotted before the drop.
alter table public.products
  drop column if exists dealer_cost_cad;
