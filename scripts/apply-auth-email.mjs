// Puts the PIM's password-reset email into Supabase Auth, with the addresses its
// link may come back to. Run again after changing supabase/templates/recovery.html:
//
//   node scripts/apply-auth-email.mjs --dry-run   (says what would change, writes nothing)
//   node scripts/apply-auth-email.mjs
//
// It writes four Auth settings through the Management API (SUPABASE_ACCESS_TOKEN in
// .env.secrets.local) and nothing else:
//   - site_url: the production address (a reset link falls back to it);
//   - uri_allow_list: the addresses a link may return to — production and local dev;
//     entries that are already there are kept;
//   - the recovery email's subject and its HTML (supabase/templates/recovery.html).
//
// The email's button is {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery:
// the app's /reset-password page takes the token when the person saves their new
// password (features/auth/api/password.js), never when the link is merely opened.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'vcmizxflfjcpxeccezlc';
const SITE_URL = 'https://pim-stylish.vercel.app';
const RETURN_TO = [`${SITE_URL}/**`, 'http://localhost:5173/**'];
const SUBJECT = 'Reset your Stylish PIM password';

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env.secrets.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!env.SUPABASE_ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is missing from .env.secrets.local');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const template = fs.readFileSync(path.join(ROOT, 'supabase/templates/recovery.html'), 'utf8');
for (const needed of ['{{ .RedirectTo }}', '{{ .TokenHash }}', '{{ .Email }}']) {
  if (!template.includes(needed)) {
    console.error(`The template no longer has ${needed}: not applied.`);
    process.exit(1);
  }
}

const api = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };

async function call(method, body) {
  let res;
  try {
    res = await fetch(api, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    // Never the error itself: it can carry the request, token included.
    throw new Error(`The request could not be sent (${err?.name ?? 'error'}).`);
  }
  if (!res.ok) throw new Error(`Supabase answered ${res.status} to ${method} config/auth.`);
  return res.json();
}

const before = await call('GET');
const list = String(before.uri_allow_list ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const allow = [...new Set([...list, ...RETURN_TO])].join(',');
const next = {
  site_url: SITE_URL,
  uri_allow_list: allow,
  mailer_subjects_recovery: SUBJECT,
  mailer_templates_recovery_content: template,
};

const show = (v) => (typeof v === 'string' && v.length > 120 ? `<${v.length} characters>` : JSON.stringify(v));
let changes = 0;
for (const [key, value] of Object.entries(next)) {
  const same = before[key] === value;
  if (!same) changes += 1;
  console.log(`${same ? '  same  ' : '  CHANGE'}  ${key}: ${show(before[key])}${same ? '' : ` -> ${show(value)}`}`);
}
console.log(`mail service: ${before.smtp_host ? `SMTP ${before.smtp_host}` : "Supabase's own (writes only to the organisation's members, a few emails an hour)"}`);

if (dryRun) {
  console.log(`\nDry run: ${changes} setting${changes === 1 ? '' : 's'} would change. Nothing was written.`);
} else if (!changes) {
  console.log('\nNothing to change.');
} else {
  const after = await call('PATCH', next);
  const kept = Object.entries(next).every(([key, value]) => after[key] === value);
  console.log(kept ? `\nApplied: ${changes} setting${changes === 1 ? '' : 's'} changed.` : '\nSupabase answered, but not every setting reads back as sent: check the Auth settings.');
  if (!kept) process.exit(1);
}
