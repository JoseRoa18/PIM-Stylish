-- Installation manuals split by installation type for sinks: a dual-mount
-- sink ships THREE manuals (undermount, drop-in, dual mount), each in its
-- language variants. New document_type values join the check constraint;
-- the generic 'installation_manual' stays for faucets/legacy docs.
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
      'cut_out_template',
      'video'
    )
  );
