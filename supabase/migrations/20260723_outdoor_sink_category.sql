-- Adds the Outdoor Sink & Ice Chest category to the product_category enum.
-- The enum predates the repo's migrations (created with the original schema);
-- frontend pickers/import already accept 'outdoor_sink' (commit 8ca5ded).
ALTER TYPE product_category ADD VALUE IF NOT EXISTS 'outdoor_sink';
