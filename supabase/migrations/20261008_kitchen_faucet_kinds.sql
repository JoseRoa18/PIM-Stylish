-- Two kinds of kitchen faucet become categories of their own (user,
-- 2026-10-08, from the "PIM - Datos de productos" file): the faucet + tap /
-- soap dispenser combos and the cold water taps. Every rule, export and
-- template treats them as kitchen faucets (supabase/functions/_shared/categories.js).
alter type public.product_category add value if not exists 'kitchen_faucet_combo' after 'kitchen_faucet';
alter type public.product_category add value if not exists 'cold_water_tap' after 'kitchen_faucet_combo';
