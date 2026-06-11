-- The product_media.document_type column already exists with a CHECK
-- constraint from the original schema. Recreate it to include the new
-- 'warranty_file' type (and 'video' for future use).

ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_document_type_check;

ALTER TABLE public.product_media
  ADD CONSTRAINT product_media_document_type_check
  CHECK (
    document_type IS NULL OR document_type IN (
      'spec_sheet',
      'installation_manual',
      'warranty_file',
      'dxf_file',
      'cut_out_template',
      'video'
    )
  );

CREATE INDEX IF NOT EXISTS product_media_document_type_idx
  ON public.product_media (sku, document_type)
  WHERE document_type IS NOT NULL;
