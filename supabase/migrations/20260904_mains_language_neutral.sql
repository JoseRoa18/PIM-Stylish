-- Main pictures are language-neutral (rule 2026-09-04): ONE white main
-- (is_primary) and ONE gray hero (image_role = sinksdirect_main) per product,
-- pinned in front of every language set (EN-FR, EN-ES, EN…) by the media tab
-- and every push. Until now mains carried the language of the tab they were
-- uploaded in (216 en_fr, 38 en, 6 en_es), which forced per-language copies
-- of the main inside the sets (e.g. P-205-2 features_00_e_s = the white main
-- again). Drop the tag on every main.
update public.product_media
   set language = null
 where media_type = 'image'
   and (is_primary = true or image_role = 'sinksdirect_main')
   and language is not null;
