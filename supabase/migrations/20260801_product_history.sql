-- Product field history
-- ----------------------------------------------------------------------------
-- The audit log says WHO touched WHAT; this table records the actual values:
-- one row per changed column on every products UPDATE, written by a trigger
-- so every write path (UI, bulk bar, Wix pull, scripts) is captured. The
-- actor comes from the request JWT (null for service_role/maintenance).
-- Client access is read-only: no insert/update/delete policies — the trigger
-- (SECURITY DEFINER) is the only writer, so history is immutable in-app.
-- ----------------------------------------------------------------------------

create table if not exists public.product_history (
  id          bigint generated always as identity primary key,
  sku         text not null,
  field       text not null,
  old_value   jsonb,
  new_value   jsonb,
  actor_id    uuid,
  actor_email text,
  changed_at  timestamptz not null default now()
);

comment on table public.product_history is
  'Field-level change history for products, written by the products_log_changes trigger.';

create index if not exists product_history_sku_idx
  on public.product_history (sku, changed_at desc);

create or replace function public.log_product_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  k text;
begin
  for k in select jsonb_object_keys(n) loop
    -- Skip churn columns: timestamps touched by sync flows, and the raw Wix
    -- payload blob (huge and derivable from the channel itself).
    if k in ('updated_at', 'wix_raw', 'wix_synced_at', 'wayfair_synced_at') then
      continue;
    end if;
    if o->k is distinct from n->k then
      insert into public.product_history (sku, field, old_value, new_value, actor_id, actor_email)
      values (new.sku, k, o->k, n->k, auth.uid(), auth.jwt() ->> 'email');
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists products_log_changes on public.products;
create trigger products_log_changes
  after update on public.products
  for each row
  when (old.* is distinct from new.*)
  execute function public.log_product_changes();

alter table public.product_history enable row level security;

drop policy if exists product_history_select on public.product_history;
create policy product_history_select
  on public.product_history for select
  to authenticated
  using (true);
