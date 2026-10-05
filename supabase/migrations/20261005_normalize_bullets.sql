-- Bullet capitalization, fixed automatically (user request 2026-10-05:
-- "arreglar las mayúsculas en bullets automáticamente en PIM, ojo con eso").
--
-- The house style is "LABEL IN CAPITALS: Text that starts with a capital."
-- (2,805 of 2,872 English bullets). Every write of attributes.bullet_points /
-- bullet_points_fr — the product page, an import, the variant propagation, a
-- script — goes through normalize_bullet():
--   · the label before ": " is upper-cased, word by word, except mixed-case
--     marks written that way on purpose (cUPC);
--   · the first letter after the colon (or of a bullet without a label) is
--     upper-cased — a lower-case "cupc" becomes "cUPC", "e.g." stays;
--   · nothing else changes (finishes, brands, sizes stay as written);
--   · a bullet a CSV export wrapped in quotes (inner quotes doubled) is
--     unwrapped, and surrounding spaces are trimmed.
-- A label is the text before the first ": " (or a final ":") with at most 12
-- words and no sentence punctuation; otherwise the colon is part of the text.

create or replace function public.bullet_cap_first(s text)
returns text language plpgsql immutable as $$
declare m text[];
begin
  m := regexp_match(s, '^(\s*)(\S+)(.*)$');
  if m is null then return s; end if;
  -- the cUPC certification mark keeps its own spelling
  if m[2] ~ '^cupc' then return m[1] || 'cUPC' || substr(m[2], 5) || m[3]; end if;
  -- other mixed-case marks and abbreviations (e.g.) stay as written
  if m[2] ~ '^[[:lower:]]+[[:upper:]]' or m[2] ~ '^[[:lower:]]\.' then return s; end if;
  if left(m[2], 1) ~ '[[:lower:]]' then
    return m[1] || upper(left(m[2], 1)) || substr(m[2], 2) || m[3];
  end if;
  return s;
end $$;

create or replace function public.normalize_bullet(b text)
returns text language plpgsql immutable as $$
declare t text; pos int; lbl text; rest text;
begin
  if b is null then return null; end if;
  t := btrim(b, E' \t\r\n');
  -- a bullet wrapped in quotes by a CSV export, its inner quotes doubled
  if length(t) >= 2 and left(t, 1) = '"' and right(t, 1) = '"' then
    t := btrim(replace(substr(t, 2, length(t) - 2), '""', '"'), E' \t\r\n');
  end if;
  if t = '' then return t; end if;
  pos := strpos(t, ':');
  if pos > 1 then
    lbl := substr(t, 1, pos - 1);
    rest := substr(t, pos + 1);
    if (rest = '' or rest ~ '^\s') and lbl !~ '[.!?]' and lbl ~ '[[:alpha:]]'
       and coalesce(array_length(regexp_split_to_array(btrim(lbl), '\s+'), 1), 0) <= 12 then
      select string_agg(case
          when m[1] ~ '^cupc' then 'cUPC' || upper(substr(m[1], 5))
          when m[1] ~ '^[[:lower:]]+[[:upper:]]' then m[1]
          else upper(m[1]) end, '' order by o)
        into lbl from regexp_matches(lbl, '(\s+|\S+)', 'g') with ordinality as x(m, o);
      return lbl || ':' || public.bullet_cap_first(rest);
    end if;
  end if;
  return public.bullet_cap_first(t);
end $$;

-- A bullets value: an array (strings normalized, anything else kept) or a
-- single string.
create or replace function public.normalize_bullets(v jsonb)
returns jsonb language sql immutable as $$
  select case jsonb_typeof(v)
    when 'array' then coalesce((
      select jsonb_agg(case when jsonb_typeof(e) = 'string' then to_jsonb(public.normalize_bullet(e #>> '{}')) else e end order by i)
      from jsonb_array_elements(v) with ordinality as a(e, i)), '[]'::jsonb)
    when 'string' then to_jsonb(public.normalize_bullet(v #>> '{}'))
    else v end
$$;

create or replace function public.products_normalize_bullets()
returns trigger language plpgsql as $$
begin
  if new.attributes ? 'bullet_points' then
    new.attributes := jsonb_set(new.attributes, '{bullet_points}', public.normalize_bullets(new.attributes -> 'bullet_points'));
  end if;
  if new.attributes ? 'bullet_points_fr' then
    new.attributes := jsonb_set(new.attributes, '{bullet_points_fr}', public.normalize_bullets(new.attributes -> 'bullet_points_fr'));
  end if;
  return new;
end $$;

drop trigger if exists products_normalize_bullets on public.products;
create trigger products_normalize_bullets
  before insert or update of attributes on public.products
  for each row execute function public.products_normalize_bullets();
