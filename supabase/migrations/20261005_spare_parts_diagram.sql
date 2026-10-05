-- Faucets carry a Spare Parts Diagram among their documents (user request
-- 2026-10-05). Like every faucet document it is family-shared: one upload
-- lands on every finish of the model. The type list is the live one plus
-- 'spare_parts_diagram'.
ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_document_type_check;

ALTER TABLE public.product_media
  ADD CONSTRAINT product_media_document_type_check
  CHECK (
    document_type IS NULL OR document_type IN (
      'spec_sheet',
      'installation_manual',
      'installation_undermount',
      'installation_drop_in',
      'installation_dual_mount',
      'installation_top_mount',
      'warranty_file',
      'dxf_file',
      'dxf_undermount',
      'dxf_drop_in',
      'dxf_dual_mount',
      'dxf_top_mount',
      'cut_out_template',
      'spare_parts_diagram',
      'video'
    )
  );
