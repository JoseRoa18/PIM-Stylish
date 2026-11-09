-- Coupons (user, 2026-11-09): a percentage is general, one for the whole
-- coupon; money is per product.
alter table public.coupon_products add column if not exists discount_amount numeric;
alter table public.coupon_products drop constraint if exists coupon_products_amount_check;
alter table public.coupon_products add constraint coupon_products_amount_check check (discount_amount is null or discount_amount > 0);

alter table public.coupons drop constraint if exists coupons_discount_value_check;
alter table public.coupons drop constraint if exists coupons_percent_check;
alter table public.coupons drop constraint if exists coupons_discount_by_type;
alter table public.coupons alter column discount_value drop not null;

-- A money coupon made before this keeps its amount, now on each product.
update public.coupon_products cp set discount_amount = c.discount_value
from public.coupons c
where c.id = cp.coupon_id and c.discount_type = 'amount' and cp.discount_amount is null;
update public.coupons set discount_value = null where discount_type = 'amount';

alter table public.coupons add constraint coupons_discount_by_type check (
  (discount_type = 'percent' and discount_value > 0 and discount_value < 100)
  or (discount_type = 'amount' and discount_value is null)
);
