-- Promotion kinds (2026-09-22): the monthly promotion (market calendar,
-- automated on its boundaries), flash deals and special events (always on
-- custom dates, run manually from their own Pricing sections).
alter table public.promotions
  add column if not exists kind text not null default 'monthly'
    check (kind in ('monthly', 'flash', 'special'));
comment on column public.promotions.kind is 'monthly (calendar, automated) | flash (flash deal) | special (special event) — flash/special need starts_on/ends_on';
