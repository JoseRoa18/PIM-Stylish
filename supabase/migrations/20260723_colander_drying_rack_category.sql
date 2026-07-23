-- Adds the Colanders & Drying Racks category to the product_category enum.
ALTER TYPE product_category ADD VALUE IF NOT EXISTS 'colander_drying_rack';
