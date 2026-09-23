-- Who created each promotion (for the flash deals / special events summary:
-- who ran how many, to which portals). Backfilled from the audit trail.
alter table public.promotions add column if not exists created_by uuid references public.profiles(id) on delete set null;
create index if not exists promotions_created_by_idx on public.promotions (created_by);
update public.promotions p
set created_by = a.actor_id
from (
  select distinct on (entity_id) entity_id, actor_id
  from public.audit_log
  where entity_type = 'promotion' and action = 'create' and actor_id is not null
  order by entity_id, occurred_at asc
) a
where p.created_by is null and a.entity_id = p.id::text;
