-- Spec sheets and installation manuals come in language variants
-- (English only, English-French, English-Spanish). Add a `language`
-- column so the same document_type can hold multiple rows, one per
-- language. NULL means "not language-specific" (warranty, DXF, etc.).

ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS language text;

ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_language_check;

ALTER TABLE public.product_media
  ADD CONSTRAINT product_media_language_check
  CHECK (
    language IS NULL OR language IN (
      'en',     -- English only
      'en_fr',  -- English-French (bilingual)
      'en_es'   -- English-Spanish (bilingual)
    )
  );

-- A given product can have at most one document of each (type, language)
-- pair — e.g. only one spec_sheet/en_fr. Postgres treats NULLs as distinct
-- in unique indexes, so non-language docs (language IS NULL) aren't hard-
-- constrained here; the UI's delete-before-insert "Replace" still keeps
-- those one-per-type.
CREATE UNIQUE INDEX IF NOT EXISTS product_media_type_language_uidx
  ON public.product_media (sku, document_type, language)
  WHERE document_type IS NOT NULL;
