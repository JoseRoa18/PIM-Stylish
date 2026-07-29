-- Optional custom thumbnail (poster) for video media. NULL = default
-- behaviour: the product's second image (usually the live shot), falling
-- back to the video's own frame at second 1. Applied live 2026-07-29.
ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS thumbnail_path text;
