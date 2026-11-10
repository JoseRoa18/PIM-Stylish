-- A site's Where to Buy rows are replaced in ONE transaction (2026-11-10).
-- The scan used to delete a site's rows and then insert the new ones in
-- batches: that morning the insert was refused (the rows did not all carry the
-- same fields) after the delete had gone through, and Stylish Canada stood with
-- no links for five hours. Now a refused insert undoes the delete.
--
-- p_skus null = the whole site (the scan), else only those products (a save on
-- the product page). Each row gets the table's columns it names; a field a row
-- leaves out is null. A scan that would leave a site with under half its rows
-- is refused: a store catalog read that came back short must not empty it.
create or replace function public.where_to_buy_replace_rows(p_site text, p_skus text[], p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  before_count integer;
  new_count integer := coalesce(jsonb_array_length(p_rows), 0);
  cols text;
begin
  if p_skus is null then
    select count(*) into before_count from where_to_buy_links where site = p_site;
    if before_count > 100 and new_count < before_count / 2 then
      raise exception 'Refused: % rows would replace the % of %', new_count, before_count, p_site;
    end if;
    delete from where_to_buy_links where site = p_site;
  else
    delete from where_to_buy_links where site = p_site and sku = any(p_skus);
  end if;
  if new_count = 0 then
    return 0;
  end if;
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into cols
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'where_to_buy_links' and c.column_name <> 'id'
    and exists (select 1 from jsonb_array_elements(p_rows) r where r ? c.column_name);
  execute format('insert into where_to_buy_links (%s) select %s from jsonb_populate_recordset(null::public.where_to_buy_links, $1)', cols, cols) using p_rows;
  return new_count;
end;
$$;

revoke all on function public.where_to_buy_replace_rows(text, text[], jsonb) from public, anon, authenticated;
grant execute on function public.where_to_buy_replace_rows(text, text[], jsonb) to service_role;
