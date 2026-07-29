-- French-only ('fr') joins the language variants for media and documents
-- (images/videos/docs produced solely in French). Applied live 2026-07-29.
ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_language_check;

ALTER TABLE public.product_media
  ADD CONSTRAINT product_media_language_check
  CHECK (
    language IS NULL OR language IN (
      'en',     -- English only
      'fr',     -- French only
      'en_fr',  -- English-French (bilingual)
      'en_es'   -- English-Spanish (bilingual)
    )
  );
