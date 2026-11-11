// What the in-app assistant knows about the PIM: writes it into
// `assistant_knowledge` (read only by the `assistant` edge function).
//
//   guide        CLAUDE.md from "## Architecture" on — how the app works and
//                every rule the team has set — cut into pieces (one per
//                top-level paragraph or bullet; a very long one also at its
//                sub-bullets; short neighbours together), as JSON
//                [{ id, section, lead, text }]. The developer-only top of the
//                file (commands, environment) is left out. The assistant
//                reads the pieces a question needs.
//   guide_index  one line per piece: what the assistant is always shown, so it
//                knows what the guide covers and which piece to open.
//   database     the tables the assistant may read (assistantTables.js), with
//                their live columns and the values their list-like columns hold.
//
// The whole guide is ~90,000 tokens: sent with every question it cost ~0.75
// USD after an hour of silence. The index is a tenth of that, and a question
// opens two or three pieces.
//
// A piece about something only a few people may see (RESTRICTED: the
// ScoreCard's Company tab) is marked `only`: it is left out of the index, the
// assistant opens it only for those people, and it never reaches the team's
// guide.
//
// Then the team's guide: people who are not admins are answered from a USER
// GUIDE — each piece rewritten without the programmers' detail
// (_shared/assistantGuide.js). The `assistant` function writes it (mode
// "user_guide", Claude Sonnet 5.5, a few cents for the pieces that changed;
// about 1 USD the first time); this script calls it until nothing remains.
//
// It runs by itself after a commit that changes CLAUDE.md or the tables list
// (.githooks/post-commit, once `git config core.hooksPath .githooks` is set
// on the machine). By hand:
//   node scripts/sync-assistant-knowledge.mjs                  (writes)
//   node scripts/sync-assistant-knowledge.mjs --dry-run        (prints sizes only)
//   node scripts/sync-assistant-knowledge.mjs --index          (prints the index, writes nothing)
//   node scripts/sync-assistant-knowledge.mjs --no-user-guide  (leaves the team's guide as it is)
//
// Needs .env.local (VITE_SUPABASE_URL) and .env.secrets.local (SR_KEY,
// SUPABASE_ACCESS_TOKEN — the columns are read through the Management API).
// A conversation started before a sync goes on working: the model drops the
// reasoning it kept from the older text and answers from the new one.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSISTANT_TABLES } from '../supabase/functions/_shared/assistantTables.js'
import { guideIndexOf } from '../supabase/functions/_shared/assistantGuide.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const showIndex = process.argv.includes('--index')
const skipUserGuide = process.argv.includes('--no-user-guide')

// Pieces only some people may read: `only` names the group (the assistant
// function knows who is in it). A piece cut from a restricted one starts
// with "(Under: <its title>)".
const RESTRICTED = [
  { only: 'company', test: (text) => /^(- )?\*\*Company tab\*\*/.test(text) || /^\(Under: Company tab\)/.test(text) },
]
const env = {}
for (const file of ['.env.local', '.env.secrets.local']) {
  for (const line of readFileSync(join(root, file), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
const PROJECT = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL failed (${res.status}): ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

// ── guide ────────────────────────────────────────────────────────────────
const SPLIT_OVER = 5000 // characters: a longer piece is also cut at its sub-bullets
const SMALL = 700 // a shorter piece joins its short neighbours…
const GROUP = 1200 // …up to this size
const LEAD = 130

const plain = (s) => s.replace(/^- /, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
function leadOf(text, max = LEAD) {
  const s = plain(text)
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30))}…`
}
/** The piece's own name: its bold opening when it has one, else its first words. */
function titleOf(text) {
  const bold = text.match(/^(?:- )?\*\*(.+?)\*\*/)
  return plain(bold ? bold[1] : text).slice(0, 60)
}

function chunkGuide(markdown) {
  const sections = []
  let section = null
  let gap = false
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{2,3}\s+(.*)$/)
    if (heading) {
      section = { title: heading[1].trim(), blocks: [] }
      sections.push(section)
      gap = false
      continue
    }
    if (!section) continue
    if (!line.trim()) {
      gap = true
      continue
    }
    const last = section.blocks.at(-1)
    // A new piece: a top-level bullet, or a paragraph after a blank line or after a bullet.
    const starts = /^\S/.test(line) && (/^- /.test(line) || gap || !last || /^- /.test(last[0]))
    if (starts) section.blocks.push([line])
    else if (last) last.push(line)
    else section.blocks.push([line])
    gap = false
  }

  const chunks = []
  sections.forEach((s, si) => {
    let n = 0
    const add = (lead, text) => chunks.push({ id: `${si + 1}.${++n}`, section: s.title, lead, text })
    // Short neighbours travel together: one line of the index names them all.
    let group = []
    const flushGroup = () => {
      if (!group.length) return
      const each = Math.max(Math.floor((LEAD + 40) / group.length) - 3, 28)
      add(group.length === 1 ? leadOf(group[0]) : group.map((t) => leadOf(t, each)).join(' · '), group.join('\n'))
      group = []
    }
    for (const lines of s.blocks) {
      const text = lines.join('\n')
      const firstSub = lines.findIndex((l) => /^ {2}- /.test(l))
      if (text.length < SMALL) {
        const header = /^\*\*[^*]+\*\*$/.test(text.trim()) // a bold line opens its own group
        if (header || group.join('\n').length + text.length > GROUP) flushGroup()
        group.push(text)
        continue
      }
      flushGroup()
      if (text.length <= SPLIT_OVER || firstSub < 0) {
        add(leadOf(text), text)
        continue
      }
      const title = titleOf(text)
      const head = lines.slice(0, firstSub).join('\n')
      add(leadOf(head), head)
      let sub = null
      const flush = () => {
        if (sub) add(`${title} › ${leadOf(sub.join('\n').trim(), LEAD - 20)}`, `(Under: ${title})\n${sub.join('\n')}`)
      }
      for (const l of lines.slice(firstSub)) {
        if (/^ {2}- /.test(l)) {
          flush()
          sub = [l]
        } else {
          sub.push(l)
        }
      }
      flush()
    }
    flushGroup()
  })
  return chunks
}

const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
const from = claude.indexOf('## Architecture')
if (from < 0) throw new Error('CLAUDE.md has no "## Architecture" section any more — the guide starts there.')
const chunks = chunkGuide(claude.slice(from)).map((piece) => {
  const rule = RESTRICTED.find((r) => r.test(piece.text))
  return rule ? { ...piece, only: rule.only } : piece
})
// The index is the same for everyone: a restricted piece is not on it.
const guideIndex = guideIndexOf(chunks.filter((piece) => !piece.only))

// ── database ─────────────────────────────────────────────────────────────
// Columns whose values are a short list worth knowing by heart (table.column).
const VALUE_LISTS = [
  'products.brand', 'products.category', 'products.workflow_status',
  'product_media.media_type', 'product_media.document_type', 'product_media.language', 'product_media.image_role',
  'product_aliases.marketplace', 'amazon_links.marketplace', 'wix_links.site',
  'product_inventory.market', 'product_where_to_buy.retailer',
  'where_to_buy_links.site', 'where_to_buy_links.verdict', 'where_to_buy_links.sku_check',
  'where_to_buy_suggestions.status', 'where_to_buy_suggestions.reason',
  'promotions.kind', 'promotions.status', 'coupons.marketplace', 'coupons.discount_type',
  'scorecard_metrics.board', 'scorecard_metrics.unit', 'scorecard_metrics.auto_key',
  'audit_log.action', 'audit_log.target', 'audit_log.entity_type',
  'kpi_snapshots.scope', 'channel_health.channel', 'channel_health.target',
  'marketplace_templates.marketplace', 'marketplace_templates.purpose',
  'odoo_pending.reason', 'bestbuy_new_listings.status', 'profiles.role',
]

const names = Object.keys(ASSISTANT_TABLES)
const columnRows = await sql(`
  select c.relname as t, a.attname as col, format_type(a.atttypid, a.atttypmod) as type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname = 'public' and c.relname in (${names.map((t) => `'${t}'`).join(', ')})
  order by c.relname, a.attnum`)
const columns = {}
for (const r of columnRows) (columns[r.t] ??= []).push(r)
const missing = names.filter((t) => !columns[t])
if (missing.length) throw new Error(`assistantTables.js names tables the database does not have: ${missing.join(', ')}`)

const lists = {}
for (const entry of VALUE_LISTS) {
  const [t, col] = entry.split('.')
  if (!columns[t]?.some((c) => c.col === col)) throw new Error(`VALUE_LISTS: ${entry} is not a column`)
  const rows = await sql(`select "${col}"::text as v, count(*)::int as n from public."${t}" where "${col}" is not null group by 1 order by 2 desc limit 60`)
  lists[entry] = rows.map((r) => r.v)
}
const attributeKeys = (await sql(`select k, count(*)::int as n from public.products, jsonb_object_keys(attributes) as k group by 1 order by 2 desc, 1`))
  .map((r) => `${r.k} (${r.n})`)
const salesChannels = (await sql(`select k, count(*)::int as n from public.product_sales, jsonb_object_keys(channels) as k group by 1 order by 2 desc`)).map((r) => r.k)

const SHORT = { 'timestamp with time zone': 'timestamp', 'character varying': 'text' }
const out = []
for (const t of names) {
  const { note, hide = [] } = ASSISTANT_TABLES[t]
  out.push(`### ${t}`)
  out.push(note)
  out.push(`Columns: ${columns[t].filter((c) => !hide.includes(c.col)).map((c) => `${c.col} ${SHORT[c.type] ?? c.type.replace(/\(\d+,\d+\)/, '')}`).join(', ')}`)
  for (const [entry, values] of Object.entries(lists)) {
    if (entry.startsWith(`${t}.`) && values.length) out.push(`${entry.split('.')[1]} values: ${values.join(' | ')}`)
  }
  if (t === 'products') out.push(`Keys inside attributes (how many products have each): ${attributeKeys.join(', ')}`)
  if (t === 'product_sales') out.push(`Marketplace names inside channels: ${salesChannels.join(' | ')}`)
  out.push('')
}
const database = out.join('\n').trim()

// ── write ────────────────────────────────────────────────────────────────
const sizes = chunks.map((c) => c.text.length)
const fmt = (n) => n.toLocaleString('en-US')
const restricted = chunks.filter((piece) => piece.only).length
console.log(`guide: ${chunks.length} pieces${restricted ? ` (${restricted} restricted)` : ''}, ${fmt(sizes.reduce((a, b) => a + b, 0))} characters (longest ${fmt(Math.max(...sizes))}) · index: ${fmt(guideIndex.length)} characters · database: ${fmt(database.length)} characters (${names.length} tables)`)
if (showIndex) {
  console.log(`\n${guideIndex}`)
} else if (dryRun) {
  console.log('Dry run: nothing written.')
} else {
  const now = new Date().toISOString()
  const res = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/assistant_knowledge?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: env.SR_KEY, Authorization: `Bearer ${env.SR_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([
      { key: 'guide', content: JSON.stringify(chunks), updated_at: now },
      { key: 'guide_index', content: guideIndex, updated_at: now },
      { key: 'database', content: database, updated_at: now },
    ]),
  })
  if (!res.ok) throw new Error(`Saving the knowledge failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  console.log('Saved to assistant_knowledge.')

  // The team's guide: the function rewrites the pieces that are new or
  // changed, a batch per call, until none remains.
  if (!skipUserGuide) {
    let spent = 0
    for (let round = 0; round < 12; round++) {
      const call = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/assistant`, {
        method: 'POST',
        headers: { apikey: env.VITE_SUPABASE_ANON_KEY ?? env.SR_KEY, Authorization: `Bearer ${env.SR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'user_guide' }),
      })
      const out = await call.json().catch(() => ({}))
      if (!call.ok) {
        console.log(`The team's guide was not updated (${call.status}): ${out.error ?? 'no answer'}. Run this script again later.`)
        break
      }
      spent += Number(out.usd ?? 0)
      if (out.failed?.length) console.log(`  not rewritten this round: ${out.failed.join('; ')}`)
      if (!out.remaining) {
        console.log(`Team's guide: ${out.in_the_team_guide} pieces (${out.admins_only} are for admins only)${spent ? ` · ${spent.toFixed(2)} USD spent rewriting` : ' · nothing to rewrite'}.`)
        break
      }
      console.log(`  team's guide: ${out.rewritten} pieces rewritten, ${out.remaining} to go…`)
      if (!out.rewritten) {
        console.log("The team's guide is not complete: some pieces could not be rewritten. Run this script again later.")
        break
      }
    }
  }
}
