-- DXF files split by installation type for sinks, mirroring the
-- installation manuals: a dual-mount sink can carry undermount, drop-in and
-- dual-mount DXFs. The generic 'dxf_file' stays for legacy/non-sink docs.
-- Applied live 2026-07-31.
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
      'video'
    )
  );
