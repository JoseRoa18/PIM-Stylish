-- General warranty per brand (user rule 2026-09-29): the warranty document is
-- the same for every product of a brand — one for Stylish, one for Azuni —
-- and is managed in Settings (app_settings.brand_warranty = { "<Brand>":
-- { storage_path, file_name, file_size_bytes, mime_type, uploaded_at } }).
--
-- Every product of the brand carries it as its warranty_file row, all rows
-- pointing at ONE storage object (like family-shared documents), so every
-- reader of product_media (Wix document links, Wayfair document push,
-- template exports, completeness) keeps working unchanged.
--
--   apply_brand_warranty(brand)  puts the brand's file on all its products,
--                                replacing whatever warranty they carried;
--                                returns the storage paths no longer used
--                                there (the app deletes those files when
--                                nothing references them any more).
--   products_brand_warranty      a new product (or a brand change) gets the
--                                brand's general warranty automatically.

create or replace function public.apply_brand_warranty(p_brand text)
returns table (old_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  w jsonb;
begin
  if not public.app_is_admin() then
    raise exception 'only an admin can change the general warranty';
  end if;
  select value -> p_brand into w from app_settings where key = 'brand_warranty';
  if w is null or coalesce(w ->> 'storage_path', '') = '' then
    raise exception 'no general warranty is set for %', p_brand;
  end if;

  return query
  with gone as (
    delete from product_media m
    using products p
    where p.sku = m.sku
      and lower(p.brand) = lower(p_brand)
      and m.document_type = 'warranty_file'
    returning m.storage_path
  )
  select distinct g.storage_path from gone g where g.storage_path is distinct from (w ->> 'storage_path');

  insert into product_media (sku, media_type, document_type, language, storage_path, file_name, file_size_bytes, mime_type, is_primary, display_order)
  select p.sku, 'document', 'warranty_file', null,
         w ->> 'storage_path', w ->> 'file_name', nullif(w ->> 'file_size_bytes', '')::bigint,
         coalesce(w ->> 'mime_type', 'application/pdf'), false,
         coalesce((select max(m.display_order) + 1 from product_media m where m.sku = p.sku), 0)
  from products p
  where lower(p.brand) = lower(p_brand);
end;
$$;

revoke all on function public.apply_brand_warranty(text) from public;
grant execute on function public.apply_brand_warranty(text) to authenticated;

create or replace function public.products_brand_warranty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w jsonb;
begin
  if tg_op = 'UPDATE' and new.brand is not distinct from old.brand then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- The old brand's general warranty no longer applies to this product.
    delete from product_media
    where sku = new.sku and document_type = 'warranty_file'
      and storage_path = (select value -> old.brand ->> 'storage_path' from app_settings where key = 'brand_warranty');
  end if;
  select value -> new.brand into w from app_settings where key = 'brand_warranty';
  if w is null or coalesce(w ->> 'storage_path', '') = '' then
    return new; -- no general warranty for this brand: the product keeps its own
  end if;
  delete from product_media where sku = new.sku and document_type = 'warranty_file';
  insert into product_media (sku, media_type, document_type, language, storage_path, file_name, file_size_bytes, mime_type, is_primary, display_order)
  values (new.sku, 'document', 'warranty_file', null,
          w ->> 'storage_path', w ->> 'file_name', nullif(w ->> 'file_size_bytes', '')::bigint,
          coalesce(w ->> 'mime_type', 'application/pdf'), false,
          coalesce((select max(m.display_order) + 1 from product_media m where m.sku = new.sku), 0));
  return new;
end;
$$;

drop trigger if exists products_brand_warranty on public.products;
create trigger products_brand_warranty
  after insert or update of brand on public.products
  for each row execute function public.products_brand_warranty();
