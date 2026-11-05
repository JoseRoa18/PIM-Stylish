-- ShipStation's shipping labels, COPIED into the PIM (user, 2026-11-05: "que
-- quede la data lo más real y pura posible"). Odoo marks a delivery done when
-- its ShipStation label is made, but not always: on 2026-10-16 a batch of
-- Sinks Direct deliveries created in June–August was validated in Odoo that
-- day, so Odoo dates them Oct 16. Odoo also carries no shipping cost. The
-- label is the real record: when the shipment was prepared and what it cost.
--
-- Written only by the `shipstation-labels-sync` edge function (daily cron,
-- the last 3 days of both accounts; a backfill mode for earlier weeks — the
-- API takes ~45 s for a week of the Canada account). Read by `scorecard-fill`:
-- an order's shipping time and its real shipping cost are its Odoo
-- deliveries' labels, matched by tracking number.
create table if not exists public.shipstation_labels (
  label_id text primary key,                 -- ShipStation's own id (se-…)
  account text not null check (account in ('us', 'ca')),  -- SHIPSTATION_API_KEY / SHIPSTATION_CA_API_KEY
  tracking_number text,
  shipment_id text,
  created_at timestamptz not null,           -- when the label was made
  ship_date date,
  cost numeric,                              -- shipment_cost (0 = the carrier reported none)
  insurance_cost numeric,
  currency text,
  carrier_code text,
  service_code text,
  voided boolean not null default false,
  is_return boolean not null default false,
  synced_at timestamptz not null default now()
);

create index if not exists shipstation_labels_tracking_idx on public.shipstation_labels (tracking_number);
create index if not exists shipstation_labels_created_idx on public.shipstation_labels (account, created_at desc);

alter table public.shipstation_labels enable row level security;

-- Admins can look; nobody writes through the app (the service role writes).
create policy shipstation_labels_select on public.shipstation_labels
  for select to authenticated using (public.app_is_admin());
