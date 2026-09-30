-- Custom promotion dates PER MARKET (user rule 2026-09-30): "las fechas de
-- las promo son por país" — October runs Oct 1 to Oct 21 in Canada and Oct 1
-- to Oct 31 in the USA.
--
-- A market's own pair (ca_starts_on / ca_ends_on, us_starts_on / us_ends_on)
-- rules that market; without one, the promotion-wide pair (starts_on /
-- ends_on — flash deals and special events, whose dates are the portal's)
-- applies; without either, the market calendar. Everything reads it through
-- promoWindow() (src/features/pricing/lib/promoCalendar.js and its Deno twin).
-- The card's date editor stores a monthly promotion's dates per market (and
-- clears its promotion-wide pair); creating one with custom dates writes both
-- markets' pairs and the wide pair alike.

alter table public.promotions
  add column if not exists ca_starts_on date,
  add column if not exists ca_ends_on date,
  add column if not exists us_starts_on date,
  add column if not exists us_ends_on date;

alter table public.promotions drop constraint if exists promotions_ca_dates_check;
alter table public.promotions add constraint promotions_ca_dates_check
  check ((ca_starts_on is null and ca_ends_on is null) or (ca_starts_on is not null and ca_ends_on is not null and ca_ends_on >= ca_starts_on));
alter table public.promotions drop constraint if exists promotions_us_dates_check;
alter table public.promotions add constraint promotions_us_dates_check
  check ((us_starts_on is null and us_ends_on is null) or (us_starts_on is not null and us_ends_on is not null and us_ends_on >= us_starts_on));

comment on column public.promotions.ca_starts_on is 'Custom first day (ET) in Canada; null = starts_on, else the Canada calendar';
comment on column public.promotions.ca_ends_on is 'Custom last day (ET) in Canada; null = ends_on, else the Canada calendar';
comment on column public.promotions.us_starts_on is 'Custom first day (ET) in the USA; null = starts_on, else the USA calendar';
comment on column public.promotions.us_ends_on is 'Custom last day (ET) in the USA; null = ends_on, else the USA calendar';
comment on column public.promotions.starts_on is 'Custom first day (ET) for every market without its own pair (flash deals / special events: the portal dates); null = market calendar';
comment on column public.promotions.ends_on is 'Custom last day (ET) for every market without its own pair; null = market calendar';

-- October 2026 (the user's dates): Canada Oct 1–21 — its promotion-wide pair,
-- kept so code that only reads that pair still gets Canada right — and the
-- USA Oct 1–31 on its own pair.
update public.promotions
   set us_starts_on = date '2026-10-01', us_ends_on = date '2026-10-31'
 where id = 7 and kind = 'monthly' and period = date '2026-10-01'
   and starts_on = date '2026-10-01' and ends_on = date '2026-10-21';
