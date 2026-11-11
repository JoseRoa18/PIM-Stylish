/**
 * A price as a person types it in a cell or a file: "$1,234.50", "1234.5",
 * "1 234,50", "394 CAD" → 1234.5 (a comma before three digits groups
 * thousands; any other comma is the decimal one). Returns
 * `{ value, bad }`: an empty cell is `value: null`; a text that is no number
 * ("39O", "12-", "TBD") is `bad: true`, so it is said instead of guessed —
 * until 2026-11-11 the letters were dropped and "39O" was read as 39.
 */
export function readMoney(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null, bad: false };
  let t = s.replace(/CAD|USD|CA\$|US\$|C\$|\$|\s/gi, '');
  if (t.includes('.') || /,\d{3}(?!\d)/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return { value: null, bad: true };
  return { value: Math.round(parseFloat(t) * 100) / 100, bad: false };
}
