---
name: nuevo-marketplace
description: Use this skill when adding a NEW marketplace export (a new retailer's XLSX/XLSM template) to the PIM, extending an existing exporter to a new category, or debugging why a template export produces wrong/empty cells. Covers the templateFiller architecture, per-marketplace template formats, and every gotcha discovered while building the Wayfair, Amazon, BB&B, Menards, and Walmart exporters.
---

# Adding a marketplace export to Stylish PIM

The PIM fills each retailer's own XLSX/XLSM template **without altering it**: dropdowns,
Valid Values sheets, macros, and formatting must survive. This is done by editing the
worksheet XML in place via JSZip. **Never use SheetJS/xlsx to write** — it re-serializes
the workbook and destroys data validations and styling. (Reading grids for analysis is fine.)

## Architecture

- `src/features/syndication/exports/templateFiller.js` — shared machinery. Use it, don't reinvent:
  `openTemplate` (fetch from Storage + unzip), `sheetToGrid`, `listSheetNames`,
  `buildValidMaps` + `snap` (snap free-text PIM values to the template's allowed values),
  `injectRows`, `downloadZip(zip, fileName, ext)` (handles xlsx/xlsm MIME),
  `fetchImagesBySku`, `fetchDocsBySku`, `norm` (header normalization), `colToIndex`/`indexToCol`.
- One exporter module per marketplace: `wayfairExport.js`, `amazonExport.js`, `bbbExport.js`,
  `menardsExport.js`. Each layers header detection + row building on top of templateFiller.
- Mapping modules (`wayfairMapping.js`, `amazonMapping.js`, rules inside `menardsExport.js`)
  are plain objects: normalized header label → `(product, ctx) => value`.
- Templates themselves live in the `marketplace_templates` table + the private `templates`
  Storage bucket, managed in the Templates page. Matching template→product is by
  `marketplace` + `category` + `accessoryKind()` (`src/features/templates/api/templates.js`).
- Export entry point: `handleExportMarketplace` in
  `src/features/products/components/BulkActionsBar.jsx` routes by marketplace id.

## Procedure

1. **Get the template uploaded first.** User uploads it in the Templates page with the right
   marketplace + category. File-kind regexes in `templates.js` (`KIND_FILE_RE`) must be
   typo-tolerant — real files arrive as "Cuting boards.xlsm".
2. **Analyze the format** (the `xlsx` skill helps here). Identify: which sheet holds data,
   the header row, the first data row, where valid values live, and any settings/metadata
   rows. Compare against the known formats table below — new retailers often reuse Syndigo
   or Amazon flat-file conventions.
3. **Write `<name>Export.js`**: detect the data sheet + header row, build one row per
   product with a rules lookup, `injectRows`, `downloadZip`. Category-specific rules
   override base rules (see `WAYFAIR_CATEGORY_RULES[p.category]?.[nm] ?? WAYFAIR_RULES[nm]`).
4. **Write the mapping module.** Key rules by `norm(label)`. Rules receive `(product, ctx)`
   where ctx can carry the header Set, locale, etc. Return `''` (not undefined) to leave blank.
5. **Wire the UI**: add the marketplace to `MARKETPLACE_OPTIONS` in `src/pages/Templates.jsx`
   and a route in `handleExportMarketplace` in BulkActionsBar.
6. **Test with real SKUs** from several families and open the result in Excel: dropdowns
   must still work, no repair prompt, values snapped to allowed lists.
7. Report to the user which required attributes could NOT be auto-filled (business data gaps)
   — they always ask.

## Known template formats

| Marketplace | Format | Key facts |
|---|---|---|
| Wayfair | sheet named `/^\d+ -/`, header row 4 | Valid Values sheet; variant grouping by `model_name` + dashed SKU root, Finish is primary axis |
| Amazon (CA/US) | full seller flat file, XLSM | A1 settings string declares labelRow=4 / attributeRow=5 / dataRow=7; repeated labels (Bullet Point ×5, Other Image URL ×8) filled by occurrence; Valid Values rows `"Label - [ TYPE ]"`; US labels say `(en_US, ...)` — normalize to `(en_CA, ...)` for rule lookup |
| Menards (Syndigo) | rows 1–5 = GUIDs/source/locale/requiredness/names, data row 6 | One category = content file + 5 container files that are DISTINCT dimensions despite near-identical filenames `(n)`; dedupe by internal data-sheet name, NEVER by filename; deliver as ONE ZIP with original filenames |
| BB&B | First Cost sheet, 268 cols | inline strings (no sharedStrings) |
| Walmart CA | multilocale spec v3.x | data sheet has "Version=…" in A1; labels R4, attribute XML names R5 (the stable key), data R7; _en/_fr pairs (leave _fr blank); repeated XML names fill by occurrence; closed lists on the Hidden_* sheet |
| Home Depot US | Mirakl | "Data" sheet: labels R1, attribute GUIDs R2, data R3; snap against GUID-keyed ReferenceData columns; requiredness per collection in the "Columns" sheet; Product Category = full collection path string |

## Gotchas (each of these caused a real bug)

- **Axis translation.** Retailers say "Width" meaning the PIM's *length*:
  - Wayfair `Overall Width - Side to Side` = PIM length ONLY when the template has no
    `Overall Length - End to End` column — rules must check the header Set.
  - Amazon: Width Side-to-Side = length, Depth Front-to-Back = width, Height = height.
  - Menards: Overall Width = length, Depth = width.
- **XLSM**: same zip, different MIME (`application/vnd.ms-excel.sheet.macroEnabled.12`);
  preserve the original extension on download and on upload contentType.
- **Valid values snapping**: PIM free text rarely matches dropdown casing
  ("Brushed stainless steel" vs "Brushed Stainless Steel"). Snap case-insensitively; apply
  alias maps only when the literal value doesn't match — don't downgrade specific values
  like "Stainless Steel (18/0)".
- **PostgREST caps unfiltered selects at ~1000 rows** — always query with `sku=in.(...)`
  for the selected SKUs, or coverage checks silently report everything missing.
- **Locale-sensitive money**: never leak CAD into a US template (`List Price` returns `''`
  when ctx.lang === 'en_US' until USD pricing exists).
- **SKUs with and without dashes are different brands** (`A-906` ≠ `A906`) — never merge.
- **PIM is the source of truth**: fill templates and fix channel diffs by pushing FROM the
  PIM; never copy marketplace data back in.
- Keep heavy deps (JSZip) out of the initial bundle — exporters are reached from
  lazy-loaded routes; import JSZip dynamically (`loadJSZip`).
- **Sheet names with `&`** arrive XML-entity-encoded from raw regex parsing;
  `listSheetNames` decodes them (fixed) — compare decoded names only.
- **Spec-wide accessory templates** (file name mentions no accessory kind, e.g.
  Walmart's "omniintl-…" file) match EVERY accessory — the kind gate only
  applies to kind-specific file names.

## Done checklist

- [ ] Template opens in Excel with dropdowns intact, no repair dialog
- [ ] Multi-file sets download as one ZIP with original filenames
- [ ] Tested with ≥2 product families incl. accessories if applicable
- [ ] Unfillable required attributes reported to the user
- [ ] Marketplace appears in Templates page options and in the bulk-export menu
