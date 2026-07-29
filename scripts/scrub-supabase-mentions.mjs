/**
 * Remove "Supabase" mentions from historical activity_log rows:
 *   - summary "... (Supabase)" → "..."
 *   - target 'supabase' → 'pim'
 *
 * Usage:
 *   node scripts/scrub-supabase-mentions.mjs           → preview
 *   node scripts/scrub-supabase-mentions.mjs --apply   → apply
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(resolve(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const BASE = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const apply = process.argv.includes('--apply');

const res = await fetch(
  `${BASE}/rest/v1/audit_log?or=(target.eq.supabase,summary.ilike.*supabase*)&select=id,target,summary&limit=10000`,
  { headers },
);
if (!res.ok) { console.error(await res.text()); process.exit(1); }
const rows = await res.json();

console.log(`Found ${rows.length} row(s) mentioning Supabase.`);
for (const r of rows) {
  const patch = {};
  if (r.target === 'supabase') patch.target = 'pim';
  if (/supabase/i.test(r.summary ?? '')) {
    patch.summary = r.summary.replace(/\s*\((Supabase)\)/gi, '').replace(/supabase/gi, 'PIM');
  }
  console.log(`- ${r.id}: target=${r.target} | ${r.summary}`);
  console.log(`    → target=${patch.target ?? r.target} | ${patch.summary ?? r.summary}`);

  if (apply) {
    const up = await fetch(`${BASE}/rest/v1/audit_log?id=eq.${r.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });
    if (!up.ok) { console.error(`  FAILED: ${await up.text()}`); process.exit(1); }
  }
}
console.log(apply ? 'Done.' : 'Preview only — run with --apply to write.');
