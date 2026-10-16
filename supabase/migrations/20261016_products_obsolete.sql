-- Obsolete products (user, 2026-10-16: "tenemos que colocar algo como para
-- marcar un producto obsoleto … pero que no sea el status"). A mark of its
-- own, apart from workflow_status: the status drives listings and the channel
-- flows, the mark changes none of them — a product can stay Ready to Sell
-- while its last units sell. PIM completeness leaves obsolete products out,
-- promotions warn about them, and the catalog shows and filters them.
--
-- Only obsolete or not ("solo el botón obsolete or not", the same day): the
-- first version also kept the day it was marked, a replacement SKU and a
-- note; they were dropped. When the mark changed and who changed it is in
-- product_history and the Activity Log.

alter table public.products
  add column if not exists is_obsolete boolean not null default false;

comment on column public.products.is_obsolete is
  'Obsolete mark (2026-10-16). Independent of workflow_status: changes no listing, push, export, promotion or price alignment. Left out of PIM completeness.';

-- Any writer may send null (a bulk import's empty cell in a batch insert):
-- null is "not obsolete".
create or replace function public.products_obsolete_mark()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.is_obsolete := coalesce(new.is_obsolete, false);
  return new;
end $$;

drop trigger if exists products_obsolete_mark on public.products;

alter table public.products
  drop column if exists obsolete_since,
  drop column if exists obsolete_replaced_by,
  drop column if exists obsolete_note;

create trigger products_obsolete_mark
  before insert or update of is_obsolete on public.products
  for each row execute function public.products_obsolete_mark();
