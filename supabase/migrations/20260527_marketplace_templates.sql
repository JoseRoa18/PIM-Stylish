-- Marketplace export templates: stores metadata about uploaded XLSX/CSV
-- templates that the PIM uses to generate filled exports per channel.

CREATE TABLE IF NOT EXISTS public.marketplace_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace   text NOT NULL,
  file_name     text NOT NULL,
  storage_path  text NOT NULL,
  sheet_names   text[] DEFAULT '{}',
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_templates_marketplace_idx
  ON public.marketplace_templates (marketplace);
