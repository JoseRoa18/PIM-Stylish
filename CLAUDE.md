# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite dev server
npm run build      # production build
npm run lint       # ESLint (flat config, eslint.config.js)
npm run preview    # serve the production build locally
```

There is no test suite. Verification is done by running the app against the live Supabase project.

Edge functions MUST be deployed with the explicit project ref (a plain `deploy` targets the wrong project and returns NOT_FOUND):

```bash
supabase functions deploy <name> --project-ref vcmizxflfjcpxeccezlc
```

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
- `workflow_status` values are centralized in [src/features/products/lib/workflowStatus.js](src/features/products/lib/workflowStatus.js) — add new statuses there only.
- SKUs with and without dashes are DIFFERENT brands (e.g. `A-906` vs `A906`), not duplicates. Never merge/delete on that assumption without asking.
- Mutations log to the audit trail via `logActivity` ([src/features/activity/api/activityLog.js](src/features/activity/api/activityLog.js)).
- In PIM ↔ marketplace discrepancies, the PIM is the source of truth: fix diffs by pushing from the PIM, not by copying channel data in.

### Syndication exports (the core domain logic)

`src/features/syndication/exports/` fills marketplace XLSX templates **without altering them**: [templateFiller.js](src/features/syndication/exports/templateFiller.js) edits the worksheet XML in place via JSZip so dropdowns/valid-values/formatting survive (SheetJS would destroy them). Each marketplace exporter (`wayfairExport`, `amazonExport`, `bbbExport`, `menardsExport`) layers its own header detection and row-building rules on top. Wayfair variant grouping: group by `model_name` + dashed SKU root, Finish is the primary axis. Marketplace template files themselves are managed in the Templates page (`marketplace_templates` table + Storage).

### Edge functions (supabase/functions/)

- `admin-users` — user CRUD with service_role (caller must be an authenticated admin).
- `wayfair-*` — Wayfair API integration (pull-groups, push-content, push-attributes).
- `wix-*` — Wix catalog sync (import/list/pull/push/read).

### scripts/

One-off Node maintenance scripts (`node scripts/<name>.mjs`) that hit the Supabase REST API directly with the service_role key from `.env.secrets.local` (e.g. data normalization and inspection utilities). All product media/documents live in Supabase Storage — Dropbox was fully removed 2026-07-23.
