-- Promotions may run on custom dates instead of the market calendar
-- (USA: 1st → month end; Canada: first Thursday → day before the next).
-- When both dates are set they apply to EVERY market and channel; when
-- null the calendar rules stay in force. Period remains the month the
-- promotion belongs to (ordering, naming, one board per month).
alter table public.promotions
  add column if not exists starts_on date,
  add column if not exists ends_on date,
  add constraint promotions_custom_window_chk
    check ((starts_on is null and ends_on is null) or (starts_on is not null and ends_on is not null and ends_on >= starts_on));
comment on column public.promotions.starts_on is 'Custom first day (ET) for every market; null = market calendar';
comment on column public.promotions.ends_on is 'Custom last day (ET) for every market; null = market calendar';
