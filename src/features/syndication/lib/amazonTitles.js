// Amazon Item Name (≤ 75) + Item Highlight (≤ 125), built only from the
// product's own PIM data — Jessica's instructions (2026-10-09, the
// "amazon-product-titles" rules): Brand first, then series → size → material →
// bowls → mounting → type → color → model number; a trimming ladder when the
// Name is too long, and what it trims (plus the key specs) in the Highlight.
// `amazonTitle(product, { colorVariant })` returns { name, highlight, flags };
// a color variant (a family sibling with another finish) always keeps its
// color. English only: the Amazon listing templates carry en_CA / en_US fields.

import { channelCategory } from '@/features/products/lib/categories';

const NAME_MAX = 75;
const HIGHLIGHT_MAX = 125;
const attr = (p) => p.attributes || {};
const s = (v) => String(v ?? '').trim();
const numText = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 100) / 100);
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tidy = (t) => t.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '').trim();
const notApplicable = (v) => /^(does not apply|not applicable|n\/a|none)$/i.test(s(v));

// ---------- validation (the skill's validate_amazon_titles.py, ported) ----------
const BANNED = new Set(['!', '$', '?', '_', '{', '}', '^', '¬', '¦']);
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'in', 'on', 'over', 'with', 'of', 'to', 'at', 'by']);
const SPELLED = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']);
const PROMO = ['free shipping', 'best seller', 'hot item', 'guarantee', '100%', 'fsa', 'hsa'];
const CLAIMS = ['commercial-grade', 'commercial grade', 'surgical', 'patina', 'super-thick', 'super thick',
  'lifetime warranty', 'unlike competitors', 'reversible'];
export function titleIssues(text, field) {
  const issues = [];
  const max = field === 'name' ? NAME_MAX : HIGHLIGHT_MAX;
  if (text.length > max) issues.push(`over the limit: ${text.length}/${max}`);
  const bad = [...new Set([...text].filter((c) => BANNED.has(c)))];
  if (bad.length) issues.push(`banned character ${bad.join(' ')}`);
  if (/[ÆŠŒŸŽæšœÿž]/.test(text)) issues.push('non-language character');
  const counts = {};
  for (const w of text.toLowerCase().match(/[a-zà-ÿ0-9\-/]+/g) ?? []) if (!STOP.has(w)) counts[w] = (counts[w] ?? 0) + 1;
  const rep = Object.entries(counts).filter(([, n]) => n > 2).map(([w, n]) => `${w} x${n}`);
  if (rep.length) issues.push(`word repeated more than twice: ${rep.join(', ')}`);
  const spelled = Object.keys(counts).filter((w) => SPELLED.has(w));
  if (spelled.length) issues.push(`spelled-out number: ${spelled.join(', ')}`);
  const low = text.toLowerCase();
  const hits = [...PROMO, ...CLAIMS].filter((x) => low.includes(x));
  if (hits.length) issues.push(`not allowed: ${hits.join(', ')}`);
  if (field === 'name' && /[A-Z]/.test(text) && text === text.toUpperCase()) issues.push('all caps');
  if (/"|''|″|”/.test(text)) issues.push('quotation mark for inches');
  return issues;
}

// ---------- shared pieces ----------
const SHADE = '(?:matte |glossy |brushed |polished |light |dark )?';
const brandOf = (p) => (/azuni/i.test(p.brand ?? '') ? 'Azuni' : 'Stylish');
const isStainless = (p) => /stainless/i.test(s(p.material));
const materialName = (p) => {
  const m = s(p.material);
  if (/granite/i.test(m)) return 'Granite Composite';
  if (/stainless/i.test(m)) return 'Stainless Steel';
  if (/porcelain/i.test(m)) return 'Porcelain';
  if (/ceramic/i.test(m)) return 'Ceramic';
  if (/brass/i.test(m)) return /solid/i.test(m) ? 'Solid Brass' : 'Brass';
  if (/bamboo/i.test(m)) return 'Bamboo';
  if (/silicone/i.test(m)) return 'Silicone';
  if (/wood fiber/i.test(m)) return 'Wood Fiber';
  return '';
};
// A coated sink (graphite black, Dura-Tek): the coating is its defining
// attribute and outranks "Stainless Steel" in the Name (skill, example 3).
const coatingOf = (p) => {
  const f = s(p.finish);
  if (/dura-?tek/i.test(f) && /graphite/i.test(f)) return 'graphite black Dura-Tek coating';
  if (/dura-?tek/i.test(f)) return 'Dura-Tek coating';
  if (/graphite/i.test(f) && isStainless(p)) return 'graphite black coating';
  return '';
};
// Finish for a sink Name: the material words come out ("Brushed Stainless
// Steel" → "Brushed"), a coating reads by its color.
const sinkFinish = (p) => {
  const f = s(p.finish);
  if (/graphite/i.test(f)) return 'Graphite Black';
  if (/^dura-?tek$/i.test(f)) return '';
  return tidy(f.replace(/\bstainless steel\b/i, ''));
};
const isPlainBrushed = (p) => /^brushed( stainless steel)?$/i.test(s(p.finish));
// 16 3/4" · 16-3/4 in. · 16.75" → "16.75 inch"; quotation marks never stay.
const cleanInches = (t) => tidy(s(t)
  .replace(/(\d+)[ -](\d+)\/(\d+)\s*(?:"|″|”|''|in\.|inches|inch|in\b)/gi, (m, a, b, c) => `${Math.round((Number(a) + Number(b) / Number(c)) * 100) / 100} inch`)
  .replace(/(\d+(?:\.\d+)?)\s*(?:"|″|”|''|in\.|inches|inch)(?=[\s,.)/-]|$)/gi, '$1 inch'));

// Accessories list → "grid, 2 strainers, cutting board" (codes out,
// quantities kept) and their total count for the pieces check — a plural
// without a number ("Grids") counts as at least 2 and is never given one.
const plural = (w) => (/s$/.test(w) ? w : /[^aeiou]y$/.test(w) ? w.replace(/y$/, 'ies') : /(x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`);
function accessoriesOf(p) {
  const count = new Map(); // item → quantity; the same item twice reads "2 cutting boards"
  let total = 0;
  for (const raw of list(attr(p).accessories_included).flatMap((x) => s(x).split(/\s+and\s+(?=[A-Z])/))) {
    const given = raw.match(/\(x\s*(\d+)\)/i)?.[1];
    const t = tidy(raw.replace(/\(x\s*\d+\)/i, '').replace(/\([^)]*\)/g, '')
      .replace(/\b[A-Z]{1,3}-?\d{2,4}[A-Z]{0,3}(KIT)?\b/g, '')).toLowerCase();
    if (!t) continue;
    const q = Number(given ?? 1);
    count.set(t, (count.get(t) ?? 0) + q);
    total += given == null && /[^s]s$/.test(t) ? 2 : q;
  }
  const items = [...count].map(([t, q]) => (q > 1 ? `${q} ${t.replace(/(\w+)$/, (w) => plural(w))}` : t));
  return { items, total };
}
// "a, b, c included", or — when the whole list does not fit — its first items.
const includedFrag = (items) => items.map((_, i) => `${items.slice(0, items.length - i).join(', ')} included`);
// Workstation accessories (a strainer basket is not one).
const isWorkstationItem = (x) => /cutting board|colander|drying rack|serving board|insulated lid|\blid\b|basket/i.test(x) && !/strainer/i.test(x);
const joinItems = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');

// Compose a Name from its segments, dropping them by the ladder until it fits.
function fitName(parts, compose, ladder, flags) {
  const on = new Set(Object.keys(parts).filter((k) => parts[k]));
  const dropped = [];
  let name = compose(on);
  for (const key of ladder) {
    if (name.length <= NAME_MAX) break;
    if (!on.has(key)) continue;
    on.delete(key);
    dropped.push(key);
    name = compose(on);
  }
  if (name.length > NAME_MAX && / inch\b/.test(name)) {
    name = name.replace(/ inch\b/g, ' in');
    flags.push('"inch" shortened to "in" to fit 75 — needs sign-off');
  }
  if (name.length > NAME_MAX) flags.push(`VERIFICATION REQUIRED: Name ${name.length}/75 after every trim`);
  return { name, dropped };
}
// Highlight: comma fragments in priority order; one that would pass 125 or
// repeat a word a third time is left out and the next ones still get a try.
const repeatsWord = (text) => titleIssues(text, 'highlight').some((i) => i.startsWith('word repeated'));
function fitHighlight(fragments) {
  const seen = new Set();
  let out = '';
  for (const frag of fragments) {
    // a fragment can offer shorter alternatives, longest first
    for (const f of list(frag).map((x) => tidy(x ?? '')).filter(Boolean)) {
      if (seen.has(f.toLowerCase())) break;
      const next = out ? `${out}, ${f}` : f;
      if (next.length > HIGHLIGHT_MAX || repeatsWord(next)) continue;
      seen.add(f.toLowerCase());
      out = next;
      break;
    }
  }
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}
// Title Case for the English Name: every word starts with a capital except
// articles, conjunctions, prepositions and units; capitals already there stay
// (RO, T-304, cUPC).
const LOWER_WORDS = new Set([...STOP, 'inch', 'in', 'x', 'ml', 'oz']);
const titleCase = (text) => text.split(' ').map((w, i) => {
  if (i > 0 && LOWER_WORDS.has(w.toLowerCase())) return w;
  return w.replace(/(^|-)([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
}).join(' ');
// "Side Drain / Reversible" → "side drain" (never claim reversible).
const drainText = (v) => {
  const d = s(v).replace(/\s*\/\s*reversible/i, '').replace(/\bdrain\b/i, '').trim().toLowerCase();
  return d && !notApplicable(d) ? `${d} drain` : '';
};

// ---------- sinks (on Amazon every sink but a bathroom one is a kitchen sink) ----------
function kitchenSink(p, ctx, flags) {
  const a = attr(p);
  const ext = a.external_dimensions_in ?? {};
  const coating = coatingOf(p);
  const material = coating ? '' : materialName(p);
  const n = Number(a.number_of_bowls);
  const split = s(a.basin_split).replace(/\s+/g, '');
  const bowl = n >= 2 || /double/i.test(s(a.bowl_configuration)) ? tidy(`${split} Double Bowl`)
    : n === 1 || /single/i.test(s(a.bowl_configuration)) ? 'Single Bowl' : '';
  const it = `${list(a.installation_type).join(' ')} ${s(p.product_type)}`;
  const install = /dual/i.test(it) ? 'Dual Mount' : /under/i.test(it) ? 'Undermount' : /top mount/i.test(it) ? 'Top Mount' : /drop/i.test(it) ? 'Drop-In' : '';
  const acc = accessoriesOf(p);
  const workstation = acc.items.some(isWorkstationItem);
  const series = s(p.series).replace(/\s*K\+$/i, '').replace(/^(azuni sink|laundry)$/i, '');
  const color = sinkFinish(p);
  const parts = {
    brand: brandOf(p), series, size: numText(ext.length) ? `${numText(ext.length)} inch` : '', material, bowl, install,
    workstation: workstation ? 'Workstation' : '',
    color: color && (ctx.colorVariant || coating || !isPlainBrushed(p)) ? color : '',
    model: p.sku,
  };
  if (!parts.size) flags.push('VERIFICATION REQUIRED: external length missing');
  const compose = (on) => {
    const head = ['brand', 'series', 'size', 'material', 'bowl', 'install', 'workstation'].filter((k) => on.has(k)).map((k) => parts[k]).join(' ');
    return `${head} Kitchen Sink${on.has('color') ? `, ${parts.color}` : ''}${on.has('model') ? `, ${parts.model}` : ''}`;
  };
  const ladder = ['model', 'bowl', 'workstation', 'series', ...(ctx.colorVariant ? [] : ['color'])];
  const { name, dropped } = fitName(parts, compose, ladder, flags);

  const frags = [];
  if (isStainless(p)) {
    const gauge = numText(a.gauge) ? `${numText(a.gauge)} gauge ` : '';
    frags.push(`${gauge}T-304${material ? '' : ' stainless steel'}${coating ? ` with ${coating}` : ''}`);
  } else if (coating) frags.push(coating);
  const lowDivider = a.low_divider === true && bowl.includes('Double');
  const bowlFrag = dropped.includes('bowl') && bowl
    ? (lowDivider ? bowl.replace('Double Bowl', 'low divider double bowl') : bowl).toLowerCase()
    : lowDivider ? 'low divider' : '';
  frags.push(tidy(`${bowlFrag}${dropped.includes('workstation') ? ' workstation' : ''}`));
  if (acc.items.length) frags.push(includedFrag(acc.items));
  if (install === 'Dual Mount') frags.push('undermount or drop-in install');
  if (dropped.includes('series') && series) frags.push(`${series} series`);
  frags.push(drainText(a.drain_hole_location));
  if (numText(a.sink_radius_mm)) frags.push(`R${numText(a.sink_radius_mm)} corners`);
  const pieces = Number(a.number_of_pieces);
  if (acc.items.length && Number.isFinite(pieces) && pieces > 0 && pieces !== 1 + acc.total) {
    flags.push(`Number of Pieces ${pieces} vs 1 sink + ${acc.total} accessories listed`);
  }
  return { name, highlight: fitHighlight(frags) };
}

// ---------- faucets: kitchen, combos, cold water taps, pot fillers, bathroom ----------
const COLOR_WORDS = '(?:matte|brushed|polished|glossy|satin)?\\s*(?:black|gold|nickel|chrome|stainless steel|gunmetal|white|red)';
const COLOR_PHRASE = new RegExp(`\\b${COLOR_WORDS}(?:\\s+(?:with|and)\\s+${COLOR_WORDS})?(?:\\s+handle)?\\b`, 'gi');
const SHADES = /\b(matte|brushed|polished|glossy|satin|handle|with|and)\b/gi;
// The type comes from the PIM title with the handles, the finish and any size
// taken out ("Single Handle Matte Black Pull-Down Kitchen Faucet" →
// "Pull-Down Kitchen Faucet"); a hose color (Carpi K-140) is the variant and
// stays. Returns the finish as the title words it ("Brushed Gold" for "Gold")
// and the colors the title names that the Finish does not.
function faucetType(p) {
  let t = cleanInches(attr(p).general_title_en);
  const hose = t.match(/\bwith (\w+) hose\b/i);
  if (hose) t = t.replace(hose[0], ' @HOSE@ ');
  t = t.replace(/\b(single[- ]handle|two[- ]handle|double[- ]handle|\d+[- ]handle)\b/gi, ' ');
  const f = s(p.finish);
  let color = f;
  if (f) {
    const re = new RegExp(`\\b${SHADE}${escapeRe(f)}\\b`, 'i');
    const hit = t.match(re);
    if (hit) {
      t = t.replace(re, ' ');
      if (hit[0].length > f.length) color = titleCase(hit[0].replace(/^\w/, (c) => c.toUpperCase()));
    }
  }
  t = t.replace(/\bchrome polished\b|\bblack matte\b|\bbrushed down\b/gi, ' ');
  const finishWords = `${f} ${s(p.color)}`.toLowerCase();
  const odd = [];
  t = t.replace(COLOR_PHRASE, (m) => {
    if (m.toLowerCase().replace(SHADES, ' ').split(/\s+/).filter(Boolean).some((w) => !finishWords.includes(w))) odd.push(tidy(m));
    return ' ';
  });
  t = t.replace(/\b\d+(\.\d+)? inch\b/gi, ' ').replace(/,?\s*\b\d+[- ](spray )?modes?\b/gi, ' ');
  t = t.replace(/\bpull down\b/gi, 'Pull-Down').replace(/\bpull out\b/gi, 'Pull-Out').replace(/\btap faucet\b/gi, 'Tap');
  if (hose) t = t.replace('@HOSE@', `with ${hose[1]} Hose`);
  t = t.replace(/\b(with|and)\s+(with|and)\b/gi, '$2');
  return { type: tidy(t.replace(/^(with|and|in)\b/i, '').replace(/\b(with|and|in)$/i, '')), color, odd };
}
function faucet(p, ctx, flags) {
  const a = attr(p);
  const handles = Number(a.number_of_handles);
  const handleText = handles === 1 ? 'Single Handle' : handles >= 2 ? `${handles}-Handle` : '';
  const model = /^combo$/i.test(s(p.model_name)) ? '' : s(p.model_name);
  const bath = channelCategory(p) === 'bathroom_faucet';
  const parsed = faucetType(p);
  let { type } = parsed;
  if (!type) {
    type = s(p.product_type) || (bath ? 'Bathroom Faucet' : 'Kitchen Faucet');
    flags.push('No PIM title: type from Product Type');
  }
  if (parsed.odd.length) flags.push(`Title says ${parsed.odd.join(' / ')}, Finish says ${s(p.finish) || '—'}`);
  // The style words before the faucet kind ("Squared Pull-Down" Kitchen
  // Faucet) are the last thing the Name gives up, one word at a time.
  const kindAt = type.search(/\b(kitchen|bathroom|pot filler|cold water|drinking|faucet|tap)\b/i);
  const style = kindAt > 0 ? type.slice(0, kindAt).trim().split(/\s+/) : [];
  const kind = kindAt > 0 ? type.slice(kindAt) : type;
  const parts = { brand: brandOf(p), model, handles: handleText, style: style.join(' '), kind, color: parsed.color, sku: p.sku };
  const compose = (on) => `${['brand', 'model', 'handles', 'style', 'kind'].filter((k) => on.has(k)).map((k) => parts[k]).join(' ')}${on.has('color') ? `, ${parts.color}` : ''}${on.has('sku') ? `, ${parts.sku}` : ''}`;
  const trimmed = [];
  let { name, dropped } = fitName(parts, compose, ['sku', 'handles', 'model'], []);
  while (name.length > NAME_MAX && style.length) {
    trimmed.push(style.shift());
    parts.style = style.join(' ');
    name = compose(new Set(Object.keys(parts).filter((k) => parts[k] && !dropped.includes(k))));
  }
  if (name.length > NAME_MAX) flags.push(`VERIFICATION REQUIRED: Name ${name.length}/75 after every trim`);

  const frags = [];
  const fns = s(a.spray_head_functions).split(/\s*[;,]\s*/).filter(Boolean).map((x) => x.toLowerCase());
  const hasSpray = a.spray_included !== false && !notApplicable(a.spray_type) && fns.length > 1;
  if (hasSpray) frags.push(`${fns.length}-function spray: ${joinItems(fns)}`);
  else if (fns.length) frags.push(joinItems(fns));
  if (trimmed.length) frags.push(`${trimmed.join(' ').toLowerCase()} design`);
  if (numText(a.max_flow_rate)) frags.push(`${numText(a.max_flow_rate)} GPM flow rate`);
  const m = materialName(p);
  if (m) frags.push(`${m.toLowerCase()} construction`);
  if (dropped.includes('handles') && handleText) frags.push(handleText.toLowerCase());
  if (dropped.includes('model') && model) frags.push(`${model} collection`);
  if (numText(a.faucet_height_in)) frags.push(`${numText(a.faucet_height_in)} inch height`);
  if (numText(a.spout_reach_in)) frags.push(`${numText(a.spout_reach_in)} inch reach`);
  if (a.deck_plate_included === true) frags.push('deck plate included');
  if (a.supply_line_included === true) frags.push('supply lines included');
  if (a.lead_free === true) frags.push('lead-free');
  return { name, highlight: fitHighlight(frags) };
}

// ---------- bathroom sinks ----------
function bathroomSink(p, ctx, flags) {
  const a = attr(p);
  const ext = a.external_dimensions_in ?? {};
  const L = numText(ext.length);
  const W = numText(ext.width);
  const size = L && W && L !== W ? `${L} x ${W} inch` : L || W ? `${L || W} inch` : '';
  const material = materialName(p);
  const shape = s(a.sink_shape);
  // the mounting type first: P-210H is a drop-in filed as a "Vessel Porcelain Sink"
  const mt = s(a.mounting_type) || list(a.installation_type).join(' ') || s(p.product_type);
  const install = /vessel/i.test(mt) ? 'Vessel' : /under/i.test(mt) ? 'Undermount' : /top mount/i.test(mt) ? 'Top Mount' : /drop/i.test(mt) ? 'Drop-In' : '';
  const acc = accessoriesOf(p);
  const drain = acc.items.find((x) => /drain/.test(x));
  const pack = /-2$/.test(p.sku) || /\bset of 2\b/i.test(s(a.general_title_en)) ? '2-Pack' : '';
  const parts = {
    brand: brandOf(p), model: s(p.model_name), size, material, shape, install,
    drain: drain ? `with ${drain.replace(/\b\w/g, (c) => c.toUpperCase())}` : '', color: sinkFinish(p), pack,
  };
  if (!size) flags.push('VERIFICATION REQUIRED: dimensions missing');
  const compose = (on) => `${['brand', 'model', 'size', 'material', 'shape', 'install'].filter((k) => on.has(k)).map((k) => parts[k]).join(' ')} Bathroom Sink${on.has('drain') ? ` ${parts.drain}` : ''}${on.has('color') ? `, ${parts.color}` : ''}${on.has('pack') ? `, ${parts.pack}` : ''}`;
  const { name, dropped } = fitName(parts, compose, ['shape', 'model', 'material', 'drain', ...(ctx.colorVariant ? [] : ['color'])], flags);

  const frags = [];
  if (dropped.includes('material') && material) frags.push(material.toLowerCase());
  if (dropped.includes('shape') && shape) frags.push(`${shape.toLowerCase()} basin`);
  if (numText(ext.depth)) frags.push(`${numText(ext.depth)} inch deep`);
  if (/^yes$/i.test(s(a.overflow))) frags.push('with overflow');
  if (/^no$/i.test(s(a.overflow))) frags.push('no overflow');
  const rest = acc.items.filter((x) => !(x === drain && !dropped.includes('drain')));
  if (rest.length) frags.push(includedFrag(rest));
  if (dropped.includes('model') && parts.model) frags.push(`${parts.model} collection`);
  return { name, highlight: fitHighlight(frags) };
}

// ---------- accessories (colanders, boards, racks, strainers, drains, plates…) ----------
// The PIM title is the product's name. Its own color moves after it (", Matte
// Black"), "Set of 2" reads "2-Pack", and a "with … / without … / for …"
// clause is what the ladder moves to the Highlight first.
const COLOR_WORD = /^(black|white|gray|grey|gold|nickel|chrome|red|brown)$/i;
const TITLE_COLORS = /\b(black|white|gray|grey|gold|nickel|chrome|red|brown)\b/gi;
const SIZED = /colander|board|rack|mat\b|organizer|dispenser|kit\b/i; // their leading size is their length
function accessory(p, ctx, flags) {
  const a = attr(p);
  const ext = a.external_dimensions_in ?? {};
  const dims = [ext.length, ext.width, ext.depth, ext.height].map(Number).filter((x) => Number.isFinite(x) && x > 0);
  // 16 7/8" reads 16.88 but the PIM stores 16.87: a title size that matches a
  // dimension takes the dimension's value.
  let t = cleanInches(a.general_title_en).replace(/(\d+(?:\.\d+)?) inch/g, (m, x) => `${dims.find((d) => Math.abs(d - Number(x)) <= 0.02) ?? x} inch`);
  if (!t) {
    t = s(p.model_name);
    if (!t) {
      flags.push('VERIFICATION REQUIRED: no title or model name in the PIM');
      return { name: '', highlight: '' };
    }
    flags.push('No PIM title: name from Model Name');
  }
  let pack = '';
  t = t.replace(/,?\s*\bset of (\d+)\b/i, (m, k) => { pack = `${k}-Pack`; return ' '; });
  const finish = s(p.finish);
  let color = '';
  if (finish && !/,|multi/i.test(finish)) {
    const words = finish.split(/\s+/);
    const forms = [
      (COLOR_WORD.test(finish) ? SHADE : '') + escapeRe(finish), // "Light Gray" for "Gray"
      words.length === 2 ? escapeRe(`${words[1]} ${words[0]}`) : null, // "Black Matte"
      COLOR_WORD.test(words.at(-1)) ? SHADE + escapeRe(words.at(-1)) : null,
      COLOR_WORD.test(s(p.color)) ? SHADE + escapeRe(s(p.color)) : null,
    ].filter(Boolean);
    for (const form of forms) {
      const re = new RegExp(`\\b(?:in )?(${form})\\b`, 'i');
      const hit = t.match(re);
      if (!hit) continue;
      t = t.replace(re, ' ');
      // the finish's own wording when the title only reorders or shortens it
      const finishWords = finish.toLowerCase().split(/\s+/);
      color = hit[1].toLowerCase().split(/\s+/).every((x) => finishWords.includes(x)) ? finish : titleCase(hit[1].replace(/^\w/, (c) => c.toUpperCase()));
      break;
    }
  }
  // A color variant always names its color; "Stainless Steel" is not said twice.
  if (!color && ctx.colorVariant && finish && !/,|multi/i.test(finish)) color = finish;
  if (/stainless steel/i.test(t)) color = tidy(color.replace(/\bstainless steel\b/i, ''));
  t = tidy(t);
  const clause = t.match(/^(.+?)\s+((?:with|without|for)\s.+)$/i);
  const head = clause ? clause[1] : t;
  const known = `${finish} ${s(p.color)}`.toLowerCase();
  const odd = [...new Set((head.match(TITLE_COLORS) ?? []).map((w) => w.toLowerCase()))].filter((w) => !known.includes(w));
  if (odd.length && !/mixed|multi|,/.test(known) && !/\bkit\b/i.test(head)) flags.push(`Title says ${odd.join('/')}, Finish says ${finish || '—'}`);
  const parts = { brand: brandOf(p), head, clause: clause ? clause[2] : '', color, pack, sku: p.sku };
  const compose = (on) => `${parts.brand} ${parts.head}${on.has('clause') ? ` ${parts.clause}` : ''}${on.has('color') ? `, ${parts.color}` : ''}${on.has('pack') ? `, ${parts.pack}` : ''}${on.has('sku') ? `, ${parts.sku}` : ''}`;
  const { name, dropped } = fitName(parts, compose, ['sku', 'clause', ...(ctx.colorVariant ? [] : ['color'])], flags);

  const titled = Number(head.match(/^(\d+(?:\.\d+)?) inch/)?.[1]);
  if (titled && SIZED.test(head) && dims.length && !dims.some((d) => Math.abs(d - titled) <= 0.02)) {
    flags.push(`Title says ${titled} inch, dimensions ${dims.join(' x ')}`);
  }

  const frags = [];
  if (dropped.includes('clause')) frags.push(parts.clause.toLowerCase());
  const m = materialName(p);
  if (m && !name.toLowerCase().includes(m.toLowerCase())) frags.push(m.toLowerCase());
  const [L, W, H] = [ext.length, ext.width, ext.height ?? ext.depth].map(numText);
  if (SIZED.test(head)) {
    const shown = [L, W, H].filter(Boolean);
    if (shown.length >= 2) frags.push(`${shown.join(' x ')} inch`);
  } else if (/strainer/i.test(head) && W && H) frags.push(`${W} inch wide, ${H} inch deep`);
  const lowName = name.toLowerCase();
  if (dropped.includes('color') && color) frags.push(`${color.toLowerCase()} finish`);
  else if (finish && !color && !isPlainBrushed(p) && !/,|multi/i.test(finish) && !lowName.includes(finish.toLowerCase())) frags.push(`${finish.toLowerCase()} finish`);
  const acc = accessoriesOf(p);
  if (acc.items.length) frags.push(includedFrag(acc.items));
  if (a.juice_grooves === true) frags.push('juice grooves');
  if (a.collapsible === true && !/roll-up|foldable|collapsible/i.test(name)) frags.push('collapsible');
  if (a.bpa_free === true) frags.push('BPA-free');
  if (Number(a.number_of_pieces) > 1) frags.push(`${Number(a.number_of_pieces)} pieces`);
  return { name, highlight: fitHighlight(frags) };
}

export function amazonTitle(product, ctx = {}) {
  const flags = [];
  const c = channelCategory(product);
  let out;
  if (/faucet|pot_filler|cold_water_tap/.test(String(product.category ?? ''))) out = faucet(product, ctx, flags);
  else if (c === 'bathroom_sink') out = bathroomSink(product, ctx, flags);
  else if (/sink/.test(c ?? '')) out = kitchenSink(product, ctx, flags);
  else out = accessory(product, ctx, flags);
  if (!out.name) return { name: '', highlight: '', flags };
  const name = titleCase(out.name);
  for (const issue of titleIssues(name, 'name')) flags.push(`Name: ${issue}`);
  for (const issue of titleIssues(out.highlight, 'highlight')) flags.push(`Highlight: ${issue}`);
  return { name, highlight: out.highlight, flags: [...new Set(flags)] };
}
