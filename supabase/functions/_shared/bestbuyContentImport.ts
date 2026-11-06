// Best Buy Canada's content import (Mirakl P41), shared by bestbuy-push-content
// (a listed product) and bestbuy-new-listing (a new one).

const BASE = "https://marketplace.bestbuy.ca/api";

// A report's lines as fields (;-separated, quoted, with line breaks inside quotes).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Only the SKU and the reason of each refused line: the report repeats the whole
// row first, so its first 4,000 characters may not even reach the reason.
export function refusals(report: string): string {
  const [head, ...lines] = parseCsv(report);
  const sku = head?.indexOf("shop_sku") ?? -1;
  const found = head?.findIndex((h) => /error/i.test(h)) ?? -1;
  const reason = found >= 0 ? found : (head?.length ?? 1) - 1;
  const out = lines.filter((l) => l.some(Boolean)).map((l) => `${sku >= 0 ? `${l[sku]}: ` : ""}${l[reason] ?? ""}`).join("\n");
  return (out || report).slice(0, 4000);
}

// CSV in the shape the transformation accepts: ;-separated, all fields quoted.
function toCsv(rows: Record<string, string>[]): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.map(q).join(";")];
  for (const r of rows) lines.push(cols.map((c) => q(r[c] ?? "")).join(";"));
  return lines.join("\n") + "\n";
}

export interface ContentImport {
  import_id: string;
  status: string;
  lines_read: number;
  lines_ok: number;
  lines_error: number;
  transformation_errors?: string;
}

/** Submits the rows and waits until the TRANSFORMATION settles; Best Buy's QC stays asynchronous. */
export async function submitContentImport(apiKey: string, rows: Record<string, string>[]): Promise<ContentImport> {
  const form = new FormData();
  form.append("file", new Blob([toCsv(rows)], { type: "text/csv" }), "stylish-pim-content-push.csv");
  const submit = await fetch(`${BASE}/products/imports`, { method: "POST", headers: { Authorization: apiKey }, body: form });
  if (!submit.ok) throw new Error(`Mirakl rejected the import: ${submit.status} ${(await submit.text()).slice(0, 300)}`);
  const { import_id } = await submit.json();

  let status: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${BASE}/products/imports/${import_id}`, { headers: { Authorization: apiKey, Accept: "application/json" } });
    status = await res.json();
    const s = String(status.import_status ?? "");
    const transformed = (status.transform_lines_read as number ?? 0) > 0 || s === "FAILED";
    if (transformed || ["COMPLETE", "FAILED", "CANCELLED"].includes(s)) break;
  }

  const linesError = (status.transform_lines_in_error as number) ?? 0;
  let transformationErrors: string | undefined;
  if (linesError > 0) {
    const rep = await fetch(`${BASE}/products/imports/${import_id}/transformation_error_report`, { headers: { Authorization: apiKey } });
    if (rep.ok) transformationErrors = refusals(await rep.text());
  }
  return {
    import_id: String(import_id),
    status: String(status.import_status ?? "SENT"),
    lines_read: (status.transform_lines_read as number) ?? rows.length,
    lines_ok: (status.transform_lines_in_success as number) ?? 0,
    lines_error: linesError,
    transformation_errors: transformationErrors,
  };
}
