-- The pre-language unique index on (sku, document_type) survived the
-- 20260617 language migration and blocked uploading a second language
-- variant of the same document type ("duplicate key value violates unique
-- constraint uniq_document_type_per_sku"). Uniqueness is enforced by
-- product_media_type_language_uidx (sku, document_type, language) since
-- 20260617 — the legacy index just has to go. Applied live 2026-07-29.
DROP INDEX IF EXISTS public.uniq_document_type_per_sku;
