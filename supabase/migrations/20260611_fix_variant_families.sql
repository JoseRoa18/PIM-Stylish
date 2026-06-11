-- Fix variant families: group strictly by base model number.
-- Rule: the base model is the SKU prefix "LETTERS-DIGITS" (e.g. S-831, S-833,
-- C-122). Suffix letters (WH, WL, WN, K…) are color/kit variant codes.
--   S-831WH, S-831WL, S-831WN, S-831WNK → one family
--   S-833WH, S-833WL, …                → a different family
--
-- Products whose base model has only one product get family_number = NULL
-- (no variants — they can be linked later from the UI).
--
-- NOTE: this renumbers family_number sequentially per base model, replacing
-- the values that came from the spreadsheet import.

-- ---- Preview first (run this SELECT alone to verify the grouping) ----
-- SELECT substring(sku from '^[A-Za-z]+-[0-9]+') AS base_model,
--        count(*) AS products,
--        array_agg(sku ORDER BY sku) AS skus
-- FROM public.products
-- GROUP BY 1
-- ORDER BY 1;

-- ---- Apply ----
WITH base AS (
  SELECT sku,
         substring(sku from '^[A-Za-z]+-[0-9]+') AS base_model
  FROM public.products
),
grp AS (
  SELECT base_model,
         count(*) AS n,
         dense_rank() OVER (ORDER BY base_model) AS new_family
  FROM base
  WHERE base_model IS NOT NULL
  GROUP BY base_model
)
UPDATE public.products p
SET family_number = CASE WHEN g.n >= 2 THEN g.new_family ELSE NULL END
FROM base b
JOIN grp g ON g.base_model = b.base_model
WHERE p.sku = b.sku;

-- ---- Verify result ----
-- SELECT family_number, array_agg(sku ORDER BY sku) AS skus
-- FROM public.products
-- WHERE family_number IS NOT NULL
-- GROUP BY family_number
-- ORDER BY family_number;
