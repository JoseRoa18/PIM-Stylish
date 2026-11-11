-- One monthly promotion per month (user, 2026-11-11, the pricing validations:
-- "hazlas todas"). Nothing stopped a second one for a month that already had
-- one, and the nightly automation (promo-apply) takes one promotion per market
-- and day — the active one, else the newest — so the other was left out
-- without a word.
--
-- An ended promotion does not count: a month whose promotion was ended can
-- get a new one. The browser says it in words before it writes
-- (monthlyOfPeriod in src/features/pricing/api/promoChecks.js, checked by the
-- form and by every create function); this index is the backstop.
create unique index if not exists promotions_one_monthly_per_month
  on public.promotions (period)
  where kind = 'monthly' and status <> 'ended';
