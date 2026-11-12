// The order of a table by one of its columns (user, 2026-11-12: "al hacerle
// click al header … mayor a menor o menor a mayor"). `sort` = { key, dir } or
// null (the table's own order).

/**
 * What a click on a column's header does: sort by it in its natural direction
 * (`first`: numbers high to low, text A to Z), a second click turns it round,
 * a third gives the table's own order back.
 */
export function nextSort(now, key, first = 'desc') {
  if (now?.key !== key) return { key, dir: first };
  return now.dir === first ? { key, dir: first === 'asc' ? 'desc' : 'asc' } : null;
}

/** aria-sort of a column's header. */
export const ariaSort = (sort, key) => (sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

/**
 * `rows` ordered by `valueOf(row)`. A row with nothing in that column (no
 * price, stock not tracked) goes last in either direction, and rows that tie
 * keep the order they had. `text`: compare as words (numbers inside them by
 * value, so A-2 comes before A-10), else as numbers.
 */
export function sortRows(rows, valueOf, dir, { text = false } = {}) {
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((a, b) => {
      const noA = a.value == null || a.value === '';
      const noB = b.value == null || b.value === '';
      if (noA || noB) return noA === noB ? a.index - b.index : noA ? 1 : -1;
      const order = text ? String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' }) : Number(a.value) - Number(b.value);
      return (dir === 'asc' ? order : -order) || a.index - b.index;
    })
    .map((x) => x.row);
}
