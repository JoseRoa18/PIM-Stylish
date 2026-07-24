-- Snapshots of channel-sync audits (e.g. the Wayfair spec-attributes audit).
-- The audit runs live in the channel workspace (takes ~1 min against the
-- Wayfair API); Listing Health reads the latest snapshot instantly.
create table if not exists channel_health (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  target text not null default '',
  run_at timestamptz not null default now(),
  total int not null default 0,
  in_sync int not null default 0,
  with_diffs int not null default 0,
  errors int not null default 0,
  partial boolean not null default false,
  top_offenders jsonb
);

alter table channel_health enable row level security;

create policy "channel_health_read" on channel_health
  for select to authenticated using (true);
create policy "channel_health_insert" on channel_health
  for insert to authenticated with check (true);
