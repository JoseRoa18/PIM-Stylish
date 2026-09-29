# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The package manager is **pnpm** (`pnpm-lock.yaml`; there is no `package-lock.json`). Vercel auto-detects it from the lockfile.

```bash
pnpm install       # install dependencies
pnpm dev           # Vite dev server
pnpm build         # production build
pnpm lint          # ESLint (flat config, eslint.config.js)
pnpm preview       # serve the production build locally
```

There is no test suite. Verification is done by running the app against the live Supabase project.

Edge functions MUST be deployed with the explicit project ref (a plain `deploy` targets the wrong project and returns NOT_FOUND):

```bash
supabase functions deploy <name> --project-ref vcmizxflfjcpxeccezlc
```

On the current Windows machine the CLI is not installed and `npx supabase` fails (no win32-x64 binary); deploys, function secrets and live SQL go through the Management API (`https://api.supabase.com/v1/projects/vcmizxflfjcpxeccezlc/...`) with `SUPABASE_ACCESS_TOKEN` from `.env.secrets.local`. Cron jobs are created inside Postgres by copying an existing job's command (the `CRON_SECRET` never leaves the database).

## Environment

- `.env.local` — `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, required at startup ([src/lib/supabase.js](src/lib/supabase.js)).
- Any new `VITE_*` variable must ALSO be added in Vercel project settings and redeployed, or production silently breaks.
- `.env.secrets.local` — `SR_KEY=` (service_role key), read only by the Node maintenance scripts in `scripts/`. Never import it in browser code.
- Hosting is Vercel as an SPA (`vercel.json` rewrites everything to `/`).

## Architecture

React 19 + Vite + Tailwind CSS v4 (via `@tailwindcss/vite`; theme tokens follow Material 3 naming like `bg-primary-container`). No backend server of its own — the app talks directly to Supabase (Postgres + Auth + Storage + Edge Functions). `@` is aliased to `src/`.

### Layout of src/

- `src/pages/*` — thin route wrappers; all routes are declared in [src/App.jsx](src/App.jsx) with route-level `lazy()` code splitting (keep heavy deps like TipTap/JSZip out of the initial bundle).
- `src/features/<feature>/{api,hooks,components,lib}` — the real code, organized by feature (products, syndication, templates, import, media, users, auth, dashboard, activity, search). `api/` modules wrap Supabase queries; `hooks/` wrap them for components.
- `src/components/layout` (AppShell/Sidebar/Topbar) and `src/components/ui` (shared primitives).

### Auth & roles

Supabase Auth + a `profiles` table with roles `admin | editor | viewer`. `ProtectedRoute` gates login; `RequireRole` gates routes (`/import` → admin+editor, `/users` and `/activity` → admin only). Anything needing the service_role key (creating/deleting users, etc.) lives in the `admin-users` edge function — never in the browser. RLS is enforced via migrations in `supabase/migrations/` (see `20260614_rls_lockdown.sql` and the storage RLS migrations).

### Data model conventions

- `products` keyed by `sku`; media in `product_media` (`is_primary` + `display_order`, storage bucket `product-images/<SKU>/`).
- Videos and documents are FAMILY-SHARED (since 2026-07-30): uploading to one variant registers a row on every product with the same `family_number`, all pointing at ONE storage object; removal clears the whole family and the file is only deleted from Storage when no row references it (`deleteStorageObjectsIfUnreferenced`). Images stay per-variant. See `src/features/media/api/media.js`; `scripts/dedupe-family-media.mjs` dedupes pre-existing per-variant copies.
- `workflow_status` values are centralized in [src/features/products/lib/workflowStatus.js](src/features/products/lib/workflowStatus.js) — add new statuses there only.
- SKUs with and without dashes are DIFFERENT brands (e.g. `A-906` vs `A906`), not duplicates. Never merge/delete on that assumption without asking.
- Mutations log to the audit trail via `logActivity` ([src/features/activity/api/activityLog.js](src/features/activity/api/activityLog.js)).
- In PIM ↔ marketplace discrepancies, the PIM is the source of truth: fix diffs by pushing from the PIM, not by copying channel data in.
- Promotion prices come ONLY from the products' price levels in Pricing (user rule 2026-09-28): monthly promotions and **flash deals run at Orange**, **special events at Purple**, on both markets and every channel. `promotion_prices` is a cache of those levels kept by database triggers (`20260928_promotion_prices_from_levels.sql`: rows are derived from the product when written — pasted lists and price files only contribute SKUs — and refreshed for draft/active promotions when a level changes; `refresh_promotion_prices(id)` re-derives one by hand). In the app the rule is `KIND_LEVEL` / `promotionLevel` in [promotions.js](src/features/pricing/api/promotions.js) (keep it in step with `promotion_level_of()` in SQL); generators that read product columns by kind (Rona, Menards, Lowe's, Walmart CA, Home Depot CA) go through it and prefer the product's level over the row. The one exception: **Bed Bath & Beyond and Overstock take flash deals at Purple** (`levelByKind` in [promoChannels.js](src/features/pricing/lib/promoChannels.js)). Never hardcode `kind === 'monthly' ? 'orange' : 'purple'` again, and never treat a pasted price as the promotion's price.
- Wayfair (Canada and USA) promotion files ALWAYS start from the file the person downloads from Partner Home right before and uploads with Fill file (user decision 2026-09-28) — never a copy in Templates: its "Current" columns are Wayfair's live snapshot. Promotions file ([wayfairPromoFill.js](src/features/pricing/lib/wayfairPromoFill.js)): only the promotion's rows are kept; USA = discount 0, WC Wayfair of the level as `$0.00`, B2B 0. Price change ([wayfairPriceChangeFill.js](src/features/pricing/lib/wayfairPriceChangeFill.js), sheet "Pricing", no dates: Wayfair applies it on import) at both ends of every promotion, monthly included: Promo MAP the day it starts (New MAP = MAP of the level, no cost) and Back to Blue the day it ends (New Base Cost = WC Wayfair Blue, New MAP = MAP Blue). Wayfair Canada (checked on its real files 2026-09-28): the base cost is in USD from its OWN levels `cost_usd_wayfair_ca*` (loaded from the user's list, [20260928_wayfair_ca_levels.sql](supabase/migrations/20260928_wayfair_ca_levels.sql); its promo cost slug `wayfair_ca_usd` derives from them), never the Wayfair/SOD CAD cost; the MAP Wayfair shows is in CAD = the Canada MAP levels (`map_cad`, `map_<level>_cad`), and `map_usd_wayfair_ca*` (that MAP / 1.38) only goes where Wayfair keeps a USD MAP too. Both markets set the B2B promo columns to 0 (Wayfair pre-fills discounts there). Menards works the same way (user rule 2026-09-29, monthly promotions and flash deals): its own file is filled at the start (F = H = MAP of the level, G = WC Menards of the level; rows outside the promotion at Blue) and goes back with "Back to Blue" the day it ends — every row at MAP Blue USD / WC Menards Blue ([menardsPromoFill.js](src/features/pricing/lib/menardsPromoFill.js)). Done tasks are stamped in `promotions.file_tasks` (`promotion_mark_task`); `PromoTaskNudge` reminds the channel owner (`app_settings.promo_channel_owners`, Settings → Promotion file owners; a channel without an owner reminds every admin). Back to Blue carries ONLY the products that went out when the promotion started (`file_tasks["<channel>:promo_file" | "<channel>:price_start"].skus`), and the start file — Menards' file, Wayfair's Promo MAP pricing file — is kept 60 days in the private bucket `promo-files` ([20260929_promo_files_bucket.sql](supabase/migrations/20260929_promo_files_bucket.sql), `savePromoFile` / `loadPromoFile`) so Back to Blue is one click ("Generate"); older files are deleted when promotions load (`expirePromoFiles`) and must be uploaded again, the product list stays. A channel joins the reminders by having `priceChange` (and `priceStart` for a start price change) in promoChannels, with its own `taskHow` wording.
- Stock lives in `product_inventory (market, sku)` — a CACHE written only by the `inventory-pull` edge function, one source per market. `us` = ShipStation Inventory (secret `SHIPSTATION_API_KEY`, the USA account's warehouses — Flowery Branch GA); ShipStation's list omits sold-out SKUs, so a tracked SKU missing from a pull is kept at 0 with `dropped_at`. `ca` = the "Stylish Inventory" Excel kept on SharePoint (PART NUMBER / QUANTITY IN STOCK CANADA / ETA CAN, found by header text on any sheet): it reaches the PIM through the daily email (`scripts/gmail-inventory-to-pim.gs` posts it with `INVENTORY_INBOUND_SECRET`) or the Settings → Stock upload; the file lists its own zeros, so a SKU not in it is not tracked (row removed). ShipStation Canada is NOT a source (its numbers are not the real stock; `SHIPSTATION_CA_API_KEY` sits unused). A missing row means *not tracked*, never 0. Matching is exact then case-insensitive; the dash is kept. Every INSERT on `products` triggers a pull (`products_request_inventory_pull`, at most one a minute) and the last report per market sits in `app_settings.shipstation_inventory` (Dashboard: source SKUs missing from the PIM; Settings → Stock: status, Refresh, upload). User rule 2026-09-28: every promo file column that asks for stock takes it from `product_inventory` — Home Depot USA's Mirakl `quantity` (USA stock, 1 when not tracked) and Rona's column J (Canada stock, 0 when not in the file) today; wire any new template's stock column the same way (`getStockFor`). Promotions (user idea 2026-09-29): creating one warns about products with 0 units in the markets it reaches (a monthly promotion both, a flash deal / special event its portals' markets — not blocking; "not tracked" is not 0), and a promotion's table tints out-of-stock rows light red with an "N out of stock" chip that filters them.

### Syndication exports (the core domain logic)

`src/features/syndication/exports/` fills marketplace XLSX templates **without altering them**: [templateFiller.js](src/features/syndication/exports/templateFiller.js) edits the worksheet XML in place via JSZip so dropdowns/valid-values/formatting survive (SheetJS would destroy them). Each marketplace exporter (`wayfairExport`, `amazonExport`, `bbbExport`, `menardsExport`) layers its own header detection and row-building rules on top. Wayfair variant grouping: group by `model_name` + dashed SKU root, Finish is the primary axis. Marketplace template files themselves are managed in the Templates page (`marketplace_templates` table + Storage).

### Edge functions (supabase/functions/)

- `admin-users` — user CRUD with service_role (caller must be an authenticated admin).
- `wayfair-*` — Wayfair API integration (pull-groups, push-content, push-attributes).
- `wix-*` — Wix catalog sync (import/list/pull/push/read).
- `promo-apply` — the monthly promotion automation (pg_cron daily 04:05/05:05 UTC): Sinks Direct USA on the 1st, Sinks Direct Canada on the first Thursday, Best Buy scheduled the day before Canada's window, and since 2026-09-28 Walmart Canada / Walmart USA scheduled the day before their window opens (safety net on the boundary day). Switches in `app_settings.promo_automation` (`enabled`, `wix`, `bestbuy`, `walmart_ca`, `walmart_us`), Settings page "Run now" reconciles. Flash deals / special events are never automated.
- `walmart-push-promo` — one market per call (`market: "ca" | "us"`): Canada = feed `PRICE_AND_PROMOTION` (Canada payload 5.0, `WM_MARKET: ca`), USA = feed `promo` (PromotionalPriceFeed 1.5, verified on Walmart's sandbox; `sandbox: true` uses the `WALMART_US_SANDBOX_*` pair and skips the listing filter). Modes push (dryRun returns the lines + payload), status, promo. A whole-promotion push stamps `promotions.wm_<market>_scheduled_at` / `wm_<market>_schedule`. Functions that import `../_shared/*` are deployed through the Management API by uploading the shared files too (`entrypoint_path` `supabase/functions/<name>/index.ts`). `_shared/serviceRole.ts` proves a service-role bearer via GoTrue admin (the runtime's `SUPABASE_SERVICE_ROLE_KEY` is not the `.env` key).
- `walmart-add-items` — Walmart USA listings, one product at a time from the product's Walmart USA card. `setup: "match"` (default on the card) = an OFFER on the listing Walmart's catalog already has for the UPC (feed `MP_ITEM_MATCH`, spec 4.2 from Walmart's documented sample: SKU, UPC, price = MAP Blue USD, shipping weight, condition) — most Stylish products are there from Walmart Canada without offers, and the seller API's catalog search can't see them. Otherwise a NEW item with full PIM content (`MP_ITEM` spec 5.0, Sinks only, validated against Get Spec); a new item on an existing UPC fails with ERR_PDI_0001 (found 2026-09-28 on S-414T). Production submits need `confirm: "CREATE"`; read-only modes `spec`, `account` (ship node 10003231796) and `get`.
- `ai-format-html` — Gemini-backed description formatter (house style + typo repairs only; a word-level validator rejects rewording). The same formatter (functions/_shared/aiFormat.ts) runs automatically inside `wix-push-product` on EVERY push that carries a description.
- `inventory-pull` — stock into `product_inventory`: USA from ShipStation Inventory (API v2, `SHIPSTATION_API_KEY`), Canada from the "Stylish Inventory" workbook (body `file` base64 — Settings upload or the Gmail script with `x-inventory-secret`; or `CA_INVENTORY_XLSX_URL` + `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` if it is ever read from SharePoint directly). Runs hourly via pg_cron (`inventory-pull-hourly`), after every product insert (trigger) and from the Refresh buttons. Body `{ mode: "pull" | "ping", market: "us" | "ca" | "all", file?, dryRun? }`; with no workbook available the hourly run leaves Canada untouched. Only esm.sh / deno.land / npm imports bundle — `cdn.sheetjs.com` is refused. Deployed with `verify_jwt` off; accepts `x-cron-secret`, a service-role bearer (proven via GoTrue admin, not by string match) or a signed-in session.

### scripts/

One-off Node maintenance scripts (`node scripts/<name>.mjs`) that hit the Supabase REST API directly with the service_role key from `.env.secrets.local` (e.g. data normalization and inspection utilities). All product media/documents live in Supabase Storage — Dropbox was fully removed 2026-07-23.
