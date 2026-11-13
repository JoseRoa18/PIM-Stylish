-- Coupons also on the Sinks Direct stores, Canada and USA (user, 2026-11-13:
-- "Coloca a Sinks Direct aca tambien. Tanto Canada como USA"). Their keys are
-- the stores' promotion channels (promoChannels.js), the ones the EOS
-- ScoreCard's Sinks Direct tab counts by. Still a record kept in the PIM.
alter table public.coupons drop constraint if exists coupons_marketplace_check;
alter table public.coupons add constraint coupons_marketplace_check
  check (marketplace in ('wix_sinksdirect_ca', 'wix_sinksdirect_us', 'wayfair_ca', 'wayfair_us', 'amazon_ca', 'amazon_us'));
