// An Excel file the in-app assistant prepares (user, 2026-11-12: "agrégale la
// función de crear documentos en Excel … en Word no, solo en Excel").
//
// The assistant DESCRIBES the file — its sheets, each one either read from a
// table of the PIM (a query) or typed by the assistant (a short table it
// worked out from its lookups) — and this module fills it. A sheet read from
// a table never passes through the model: its rows are read from the database
// by whoever holds the session, so a file of thousands of rows costs what its
// description costs, and the model cannot miscopy a row.
//
// The same code runs twice:
//   · in the `assistant` edge function, when the assistant prepares the file
//     (assistantTools.js, create_excel): the description is checked, each
//     query is tried on its first page, and the description is kept
//     (assistant_files) and shown to the person as a card;
//   · in the browser, when the person presses Download
//     (src/features/assistant/lib/excelFile.js): every row is read with THAT
//     PERSON'S session and written by the PIM's own Excel writer.
// So the file holds what the person may see, as it is when they download it.
//
// Plain JavaScript with no runtime of its own. `read(path, wantCount)` is how
// the caller reads the database's API: it resolves to { rows, total }.
import { ASSISTANT_TABLES } from "./assistantTables.js";

/** A description or a read that cannot be used as it is: the message says what to fix (it goes back to the model). */
export class SpecError extends Error {}

export const EXCEL_LIMITS = {
  sheets: 8,
  columns: 60,
  typedRows: 300, // a sheet the assistant types: it writes every cell itself
  queryRows: 20000, // a sheet read from a table
  title: 90,
};
export const EXCEL_FORMATS = ["text", "number", "money", "percent", "date", "datetime", "link"];
const PAGE = 1000; // the API returns at most 1,000 rows per request
const MAX_CELL = 32000; // Excel's own limit is 32,767 characters

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");

// ── One read of a readable table ────────────────────────────────────────────
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
const q = (v) => encodeURIComponent(v);

function hiddenIn(text, tables) {
  for (const t of tables) {
    for (const col of ASSISTANT_TABLES[t]?.hide ?? []) {
      if (new RegExp(`(^|[^a-z0-9_])${col}([^a-z0-9_]|$)`, "i").test(text)) return col;
    }
  }
  return null;
}

/**
 * A read of one of the readable tables, as the database's API takes it
 * (PostgREST): `params` are its filters, `base` the whole request without a
 * limit. One set of rules for every reader — the query_table lookup and an
 * Excel sheet: only the tables on the list (an embedded one too), never "*",
 * never a hidden column.
 */
export function tableRead({ table, select = "", filters = [], order = "" }) {
  if (!Object.hasOwn(ASSISTANT_TABLES, table)) throw new SpecError(`"${table}" is not one of the readable tables.`);
  if (select.includes("*")) throw new SpecError("List the columns you need instead of \"*\" (see <database>).");

  // An embedded table must be one of the readable ones too.
  const tables = [table];
  for (const m of select.matchAll(/([a-z_][a-z0-9_]*)(?:![a-z0-9_]+)*\s*\(/gi)) {
    if (!Object.hasOwn(ASSISTANT_TABLES, m[1])) throw new SpecError(`"${m[1]}" cannot be embedded: it is not one of the readable tables.`);
    tables.push(m[1]);
  }

  const params = [];
  for (const filter of filters) {
    const at = filter.indexOf("=");
    const key = at > 0 ? filter.slice(0, at).trim() : "";
    const value = at > 0 ? filter.slice(at + 1).trim() : "";
    if (!key || !value) throw new SpecError(`Filter "${filter}" is not "column=operator.value".`);
    if (RESERVED.has(key.toLowerCase())) throw new SpecError(`"${key}" is not a filter: use the ${key} parameter.`);
    params.push(`${q(key)}=${q(value)}`);
  }
  const hidden = hiddenIn([select, order, ...filters].join(" "), tables);
  if (hidden) throw new SpecError(`"${hidden}" is not available to the assistant (bulk data). Use the table's other columns.`);

  return { params, base: `${table}?select=${q(select)}${params.length ? `&${params.join("&")}` : ""}${order ? `&order=${q(order)}` : ""}` };
}

/**
 * The order a sheet is read in: the one asked for, then the table's own key.
 * A sheet is read 1,000 rows at a time, and without a complete order two
 * pages could repeat a row or skip one.
 */
function stableOrder(table, order) {
  const asked = String(order ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const named = new Set(asked.map((part) => part.split(".")[0]));
  const key = String(ASSISTANT_TABLES[table]?.key ?? "").split(",").filter(Boolean);
  return [...asked, ...key.filter((col) => !named.has(col)).map((col) => `${col}.asc`)].join(",");
}

// ── A row as flat cells ─────────────────────────────────────────────────────
const MAX_DEPTH = 4; // row › embedded table or JSON column › field › field

/**
 * One row of the API as flat cells, by key. An embedded table or a JSON
 * object gives "name.field" keys; the several rows of an embedded table give
 * each field's values side by side ("a; b"), and their keys are added to
 * `joined`; a list of plain values is "a; b".
 */
export function flattenRow(row, joined = null) {
  const out = {};
  const walk = (prefix, value, depth) => {
    if (isPlain(value) && depth < MAX_DEPTH) {
      const entries = Object.entries(value);
      if (!entries.length) out[prefix] = null;
      for (const [k, v] of entries) walk(prefix ? `${prefix}.${k}` : k, v, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      const objects = value.filter(isPlain);
      if (objects.length && depth < MAX_DEPTH) {
        const fields = new Map();
        for (const item of objects) {
          for (const [k, v] of Object.entries(flattenRow(item))) {
            if (v === null || v === undefined || v === "") continue;
            if (!fields.has(k)) fields.set(k, []);
            fields.get(k).push(v);
          }
        }
        if (!fields.size) out[prefix] = null;
        for (const [k, values] of fields) {
          const distinct = [...new Set(values.map((v) => (typeof v === "object" ? JSON.stringify(v) : v)))];
          if (distinct.length > 1) joined?.add(`${prefix}.${k}`);
          out[`${prefix}.${k}`] = distinct.length === 1 ? distinct[0] : distinct.join("; ");
        }
        return;
      }
      out[prefix] = value.length ? value.map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v))).join("; ") : null;
      return;
    }
    out[prefix] = value;
  };
  walk("", row ?? {}, 0);
  return out;
}

/**
 * The keys a set of flat rows holds, in the order they first appear. `open`
 * are the names that came back with nothing inside on some row (an embedded
 * table with no row): "name.field" may be a column although no row read has it.
 */
function flatKeys(rows) {
  const seen = new Set();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  const all = [...seen];
  const keys = all.filter((key) => !all.some((other) => other.startsWith(`${key}.`)));
  return { keys, open: all.filter((key) => !keys.includes(key) || rows.some((row) => row[key] === null)) };
}

// ── A cell as the file shows it ─────────────────────────────────────────────
const EASTERN = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A timestamp on the company's clock (Eastern time): "2026-11-12 09:05", or only its day. */
function easternTime(value, dayOnly) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const part = Object.fromEntries(EASTERN.formatToParts(date).map((p) => [p.type, p.value]));
  const day = `${part.year}-${part.month}-${part.day}`;
  return dayOnly ? day : `${day} ${part.hour}:${part.minute}`;
}

const stripHtml = (html) => html.replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

/**
 * A value as its cell: a number stays a number and a text a text (a UPC must
 * not become a number), Yes / No for true / false, a timestamp on Eastern
 * time, HTML as its words. `format` asks for more: number / money / percent
 * read a numeric text as a number, date keeps only the day.
 */
export function cellOf(value, format = "text") {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "object") return JSON.stringify(value).slice(0, MAX_CELL);
  let text = String(value);
  if (format === "number" || format === "money" || format === "percent") {
    const plain = text.replace(/[$,\s]/g, "");
    return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : text;
  }
  if (format === "date") return TIMESTAMP.test(text) ? easternTime(text, true) : text;
  if (format === "link") return text;
  if (TIMESTAMP.test(text) && !DAY.test(text)) return easternTime(text, false);
  if (/<[a-z][^>]*>/i.test(text)) text = stripHtml(text);
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

// A column's title when none was given: "map_cad" → "MAP CAD", "ca.available" → "CA Available".
const UPPER = new Set(["sku", "upc", "map", "msrp", "cad", "usd", "id", "url", "hs", "eta", "asin", "pim", "en", "fr", "us", "ca", "wc"]);
const titleOf = (key) => key.split(/[._]+/).filter(Boolean).map((w) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");

// ── The description, checked ────────────────────────────────────────────────
const SHEET_KEYS = ["name", "columns", "rows", "table", "select", "filters", "order"];

function checkColumn(col, label, fromTable) {
  // a bare text is the column's key (a table's sheet) or its header (a typed one)
  const c = typeof col === "string" ? (fromTable ? { key: col } : { header: col }) : col;
  if (!isPlain(c)) throw new SpecError(`${label}: each column is an object { ${fromTable ? "key, " : ""}header, format }.`);
  for (const k of Object.keys(c)) {
    if (!["key", "header", "format"].includes(k)) throw new SpecError(`${label}: a column has "${k}"; a column has only key, header and format.`);
  }
  const key = str(c.key);
  const header = str(c.header).slice(0, 120);
  const format = str(c.format) || "text";
  if (!EXCEL_FORMATS.includes(format)) throw new SpecError(`${label}: "${format}" is not a format (${EXCEL_FORMATS.join(", ")}).`);
  if (fromTable) {
    if (!key) throw new SpecError(`${label}: each column needs "key" — the name of the data it shows (a selected column, its alias, or "alias.field").`);
    return { key, header: header || titleOf(key), format };
  }
  if (!header) throw new SpecError(`${label}: each column needs "header".`);
  return { header, format };
}

function checkSheet(sheet, index) {
  if (!isPlain(sheet)) throw new SpecError(`Sheet ${index + 1} is not an object.`);
  for (const k of Object.keys(sheet)) {
    if (!SHEET_KEYS.includes(k)) throw new SpecError(`Sheet ${index + 1}: "${k}" is not a property of a sheet (${SHEET_KEYS.join(", ")}).`);
  }
  const name = str(sheet.name).slice(0, 31) || `Sheet ${index + 1}`;
  const label = `Sheet "${name}"`;
  const typed = sheet.rows !== undefined && sheet.rows !== null;
  const fromTable = str(sheet.table) !== "";
  if (typed === fromTable) {
    throw new SpecError(`${label}: give either "table" and "select" (a sheet read from the PIM) or "rows" (a sheet you type) — ${typed ? "not both" : "it has neither"}.`);
  }
  const given = sheet.columns === undefined || sheet.columns === null ? null : sheet.columns;
  if (given !== null && !Array.isArray(given)) throw new SpecError(`${label}: "columns" is a list.`);
  if (given && given.length > EXCEL_LIMITS.columns) throw new SpecError(`${label}: at most ${EXCEL_LIMITS.columns} columns.`);

  if (typed) {
    if (!given?.length) throw new SpecError(`${label}: a typed sheet needs "columns" — a header for each cell of its rows.`);
    const columns = given.map((c) => checkColumn(c, label, false));
    if (!Array.isArray(sheet.rows) || !sheet.rows.length) throw new SpecError(`${label}: "rows" is empty.`);
    if (sheet.rows.length > EXCEL_LIMITS.typedRows) {
      throw new SpecError(`${label}: at most ${EXCEL_LIMITS.typedRows} typed rows. A longer list is read from its table — give "table", "select" and "filters" instead of "rows".`);
    }
    const rows = sheet.rows.map((row, r) => {
      if (!Array.isArray(row)) throw new SpecError(`${label}: row ${r + 1} is not a list of cells.`);
      if (row.length > columns.length) throw new SpecError(`${label}: row ${r + 1} has ${row.length} cells for ${columns.length} columns.`);
      return columns.map((_, c) => {
        const cell = row[c] ?? null;
        if (cell !== null && !["string", "number", "boolean"].includes(typeof cell)) throw new SpecError(`${label}: row ${r + 1}, cell ${c + 1} is not a text, a number, true / false or null.`);
        return typeof cell === "string" ? cell.slice(0, MAX_CELL) : cell;
      });
    });
    return { name, columns, rows };
  }

  const select = str(sheet.select);
  if (!select) throw new SpecError(`${label}: give "select" — the columns to read from ${sheet.table}.`);
  const filters = sheet.filters ?? [];
  if (!Array.isArray(filters) || !filters.every((f) => typeof f === "string")) throw new SpecError(`${label}: "filters" is a list of "column=operator.value" texts.`);
  if (sheet.order !== undefined && sheet.order !== null && typeof sheet.order !== "string") throw new SpecError(`${label}: "order" is a text like "sku.asc".`);
  const query = { table: str(sheet.table), select, filters, order: str(sheet.order) };
  try {
    tableRead(query);
  } catch (err) {
    throw err instanceof SpecError ? new SpecError(`${label}: ${err.message}`) : err;
  }
  return { name, ...query, ...(given?.length ? { columns: given.map((c) => checkColumn(c, label, true)) } : {}) };
}

/**
 * The file's description, checked and tidied: { title, sheets }. A sheet is
 * { name, columns: [{ header, format }], rows } (typed) or { name, table,
 * select, filters, order, columns?: [{ key, header, format }] } (read from a
 * table). Throws a SpecError that says what to fix.
 */
export function checkExcelSpec(input) {
  if (!isPlain(input)) throw new SpecError("The file's description is not an object.");
  const title = str(input.title).replace(/\s+/g, " ").slice(0, EXCEL_LIMITS.title);
  if (!title) throw new SpecError("Give the file a \"title\".");
  if (!Array.isArray(input.sheets) || !input.sheets.length) throw new SpecError("Give \"sheets\": at least one.");
  if (input.sheets.length > EXCEL_LIMITS.sheets) throw new SpecError(`At most ${EXCEL_LIMITS.sheets} sheets in a file.`);
  return { title, sheets: input.sheets.map(checkSheet) };
}

// ── A sheet's data ──────────────────────────────────────────────────────────
/**
 * A sheet filled: { headers, formats, rows, columns, total, notes }.
 *   read     (path, wantCount) => { rows, total } — the database's API, with the reader's session
 *   maxRows  how many rows to read at most (the edge function reads one page to try a query)
 *   strict   refuse a column the data does not have (when the file is prepared);
 *            without it such a column is left empty (the download never fails for it)
 *   onRows   (done, total) as the pages arrive
 * `columns` are the sheet's own, or every key of the data when it named none;
 * `total` is how many rows match in all; `notes` say what looks wrong.
 */
export async function loadExcelSheet(sheet, read, { maxRows = EXCEL_LIMITS.queryRows, strict = false, onRows = null } = {}) {
  const label = `Sheet "${sheet.name}"`;
  if (sheet.rows) {
    return {
      headers: sheet.columns.map((c) => c.header),
      formats: sheet.columns.map((c) => c.format),
      rows: sheet.rows.map((row) => sheet.columns.map((c, i) => cellOf(row[i], c.format))),
      columns: sheet.columns,
      total: sheet.rows.length,
      notes: [],
    };
  }

  const { base } = tableRead({ table: sheet.table, select: sheet.select, filters: sheet.filters ?? [], order: stableOrder(sheet.table, sheet.order) });
  const flat = [];
  const joined = new Set();
  let total = null;
  for (let from = 0; from < maxRows; from += PAGE) {
    const size = Math.min(PAGE, maxRows - from);
    const page = await read(`${base}&limit=${size}&offset=${from}`, from === 0);
    if (from === 0) total = page.total;
    for (const row of page.rows) flat.push(flattenRow(row, joined));
    onRows?.(flat.length, Math.min(total ?? flat.length, maxRows));
    if (page.rows.length < size) break;
  }
  if (total === null || total === undefined) total = flat.length;

  const { keys, open } = flatKeys(flat);
  let columns = sheet.columns;
  if (!columns) {
    if (keys.length > EXCEL_LIMITS.columns) {
      throw new SpecError(`${label}: its data has ${keys.length} columns. Name the ones the file needs in "columns" (at most ${EXCEL_LIMITS.columns}).`);
    }
    columns = keys.map((key) => ({ key, header: titleOf(key), format: "text" }));
  } else if (strict && flat.length) {
    for (const col of columns) {
      if (keys.includes(col.key) || open.some((name) => col.key.startsWith(`${name}.`))) continue;
      throw new SpecError(`${label}: "${col.key}" is not in this sheet's data. Its data has: ${keys.slice(0, 80).join(", ")}. An embedded table's field is "alias.field"; a selected column goes by its alias.`);
    }
  }

  const rows = flat.map((row) => columns.map((c) => cellOf(row[c.key], c.format)));
  const notes = [];
  if (flat.length) {
    const empty = columns.filter((_, i) => rows.every((row) => row[i] === ""));
    if (empty.length) notes.push(`Empty on every row read: ${empty.map((c) => c.header).join(", ")}. Check the key or the filter if that is not expected.`);
    const several = columns.filter((c) => joined.has(c.key));
    if (several.length) notes.push(`Several values in one cell on some rows (joined with "; "): ${several.map((c) => c.header).join(", ")}. To get one value per row, filter the embedded table (for example "ca.market=eq.ca").`);
  }
  if (total > EXCEL_LIMITS.queryRows) notes.push(`${total} rows match: the file holds the first ${EXCEL_LIMITS.queryRows}. Filter more to get them all.`);
  return { headers: columns.map((c) => c.header), formats: columns.map((c) => c.format), rows, columns, total, notes };
}

/** The file's name: "Stylish_PIM_<Title>_<day>.xlsx" (plain letters, digits and underscores). */
export function excelFileName(title, day) {
  const words = String(title ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return `Stylish_PIM_${words || "Assistant"}_${day}.xlsx`;
}
