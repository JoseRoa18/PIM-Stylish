-- Products carry TWO main pictures: the gray-background one is the
-- SinksDirect (Wix) hero, the white-background one is the hero for every
-- other marketplace (Amazon, Wayfair, Best Buy, ...). is_primary keeps
-- meaning "marketplace main" (existing data is already the white set);
-- image_role tags the SinksDirect-only hero, which the Wix media push puts
-- first and every other consumer (template exports, Wayfair API) excludes.
alter table public.product_media
  add column if not exists image_role text;

comment on column public.product_media.image_role is
  'null = regular marketplace image. ''sinksdirect_main'' = gray-background hero used ONLY as the first image on the SinksDirect (Wix) site.';
