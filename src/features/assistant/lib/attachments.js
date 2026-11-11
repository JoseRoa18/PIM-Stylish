// What a person can attach to a question: an image (a screenshot, a photo)
// or a table (an .xlsx / .csv file). Both are made small here, in the
// browser, before they travel: an image is redrawn at most 1,400 px wide or
// tall as a JPEG, and a table is sent as text — its first rows, tab-separated.

export const ATTACH_ACCEPT = 'image/png,image/jpeg,image/webp,.xlsx,.csv';
export const MAX_ATTACHMENTS = 3;
const IMAGE_SIDE = 1400;
const IMAGE_LIMIT = 1_300_000; // base64 characters (the function takes 1.4 M)
const TABLE_ROWS = 400;
const TABLE_LIMIT = 55_000; // characters (the function takes 60,000)

async function readImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name} could not be read as an image.`);
  const scale = Math.min(1, IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // a transparent PNG becomes a JPEG on white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const quality of [0.85, 0.7, 0.5]) {
    const data = canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
    if (data && data.length <= IMAGE_LIMIT) return { kind: 'image', name: file.name, media_type: 'image/jpeg', data };
  }
  throw new Error(`${file.name} is too large even after being reduced.`);
}

const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

async function readTable(file) {
  const { parseSpreadsheetFile } = await import('@/features/import/lib/parseSpreadsheet');
  const { headers, rows } = await parseSpreadsheetFile(file);
  if (!headers?.length || !rows?.length) throw new Error(`${file.name} has no rows to read.`);
  const lines = [headers.map(cell).join('\t')];
  let size = lines[0].length;
  let sent = 0;
  for (const row of rows.slice(0, TABLE_ROWS)) {
    const line = headers.map((h) => cell(row[h])).join('\t');
    if (size + line.length + 1 > TABLE_LIMIT) break;
    lines.push(line);
    size += line.length + 1;
    sent += 1;
  }
  if (!sent) throw new Error(`${file.name}: its rows are too long to attach.`);
  const note = sent < rows.length ? `\n(The first ${sent} of ${rows.length} rows; the rest were left out.)` : '';
  return { kind: 'table', name: file.name, text: `${lines.join('\n')}${note}`, rows: sent, of: rows.length };
}

/** A chosen file, ready to send: { kind: 'image', name, media_type, data } or { kind: 'table', name, text, rows, of }. */
export function readAttachment(file) {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/')) return readImage(file);
  if (name.endsWith('.xlsx') || name.endsWith('.csv')) return readTable(file);
  return Promise.reject(new Error(`${file.name}: attach an image (PNG, JPEG, WebP) or a table (.xlsx, .csv).`));
}
