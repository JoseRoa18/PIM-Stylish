-- Full per-SKU audit results on each snapshot (not just the top offenders),
-- so Listing Health can score every product's channel sync.
alter table channel_health add column if not exists results jsonb;
