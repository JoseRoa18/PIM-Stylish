// Analytics → Progress to 100% → Export: the section as an Excel in the PIM
// Excel's look (sectionedXlsx), to work the list from:
//   Summary        where the PIM and each marketplace stand in the week
//   Week by week   their numbers at the end of each of the last 12 weeks
//   Listings left  every listing that is not at 100%, with what it fails
//   This week      the listings that reached 100% or got worse in the week
//   By issue       each check, how many listings fail it and the week's change
//   Notes          what each word and column means
// Pure: the reads are in api/progressExcel.js. Nothing is scored again — the
// numbers are the daily snapshots'.

import { BAD_UNDER, change, checkInfo, compareListings, issuesByCheck, listingsOf, sortListings, sumStandings } from './progress.js';

const BAD_FILL = 'FCE8E6';
const GOOD_FILL = 'E6F4EA';
const frac = (pct) => (pct == null ? '' : pct / 100);
const n = (v) => (v == null ? '' : v);
const labels = (scope, keys) => keys.map((k) => checkInfo(scope, k).label).join('; ');

/** "Stylish_PIM_Progress_to_100_W48_2026-11-25.xlsx" (one scope: "…_Wayfair_Canada_W48_…"). */
export function progressFileName(rows, week, date) {
  const one = rows.length === 1 ? `_${String(rows[0].scope.label).replace(/['’]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}` : '';
  return `Stylish_PIM_Progress_to_100${one}_${week.tag}_${date}.xlsx`;
}

/**
 * @param rows     the section's rows: [{ scope, now, before, series }] (lib/progress.js)
 * @param details  Map(scope.id → { now, before }) — the snapshot rows that hold each listing's detail
 * @param products Map(sku → { model_name, brand, category })
 * @param week     the selected week ({ name, tag, range })
 * @param labelOf  { category: (key) → label }
 * @param date     'YYYY-MM-DD', the day of the export
 * @returns {{ sheets: object[], listings: number }}
 */
export function progressSheets({ rows, details, products, week, labelOf, date }) {
  const channels = rows.filter((r) => r.scope.kind === 'channel');
  const compared = new Map(rows.map((r) => {
    const d = details.get(r.scope.id);
    return [r.scope.id, d ? compareListings(listingsOf(d.now), listingsOf(d.before)) : null];
  }));
  const product = (sku) => products.get(sku) ?? {};
  const productCells = (sku) => [sku, product(sku).model_name ?? '', product(sku).brand ?? '', product(sku).category ? labelOf.category(product(sku).category) : ''];

  // ---- summary ----
  const standRow = (label, now, before) => [label, n(now?.total), n(now?.complete), frac(now?.pct), n(now?.left), n(now?.bad), n(now?.issues), n(change(now, before, 'issues'))];
  const all = channels.length > 1 ? { now: sumStandings(channels.map((r) => r.now)), before: sumStandings(channels.map((r) => r.before)) } : null;
  const summary = {
    name: 'Summary',
    title: `Progress to 100% — ${week.name}`,
    subtitle: `${week.range} · from the PIM's daily snapshots · exported ${date}`,
    widths: [30, 11, 11, 9, 9, 9, 12, 14],
    blocks: [
      {
        title: 'Where each one stands',
        note: `An issue is one check a listing fails. Bad = a score under ${BAD_UNDER}. "Change" = the open issues against the start of the week (a negative number is progress).`,
        headers: ['Where', 'Listings', 'At 100%', 'Share', 'Left', 'Bad', 'Open issues', 'Change in the week'],
        formats: ['topic', 'count', 'count', 'percent', 'count', 'count', 'count', 'count'],
        rows: rows.map((r) => standRow(r.scope.label, r.now, r.before)),
        ...(all?.now ? { total: standRow('All marketplaces', all.now, all.before) } : {}),
      },
      ...(rows.some((r) => compared.get(r.scope.id)?.hasBefore) ? [{
        title: `What moved in ${week.name}`,
        note: 'Counted listing by listing against the start of the week. A listing no longer scored (archived, obsolete) fixed nothing.',
        headers: ['Where', 'Issues fixed', 'New issues', 'Reached 100%', 'Dropped below 100%'],
        formats: ['topic', 'count', 'count', 'count', 'count'],
        rows: rows.filter((r) => compared.get(r.scope.id)?.hasBefore).map((r) => {
          const c = compared.get(r.scope.id);
          return [r.scope.label, c.fixed, c.added, c.reached.length, c.dropped.length];
        }),
      }] : []),
    ],
  };

  // ---- week by week ----
  const weekSections = [
    { title: 'Week', color: '1F3864', headers: ['Where', 'Week', 'Days'] },
    { title: 'Listings', color: '01579B', headers: ['Listings', 'At 100%', 'Share at 100%', 'Left', `Bad (under ${BAD_UNDER})`, 'Average Score'] },
    { title: 'Issues', color: '1E5631', headers: ['Open Issues', 'Change vs Week Before'] },
  ];
  const weekRows = [];
  for (const r of rows) {
    let prev = null;
    for (const p of r.series) {
      if (!p.standing) continue;
      const s = p.standing;
      weekRows.push([r.scope.label, p.label, p.range, n(s.total), n(s.complete), frac(s.pct), n(s.left), n(s.bad), n(s.avg), n(s.issues), n(change(s, prev, 'issues'))]);
      prev = s;
    }
  }
  const weekSheet = {
    name: 'Week by week',
    sections: weekSections,
    rows: weekRows,
    formats: [null, 'center', null, 'count', 'count', 'percent', 'count', 'count', 'count', 'count', 'count'],
    widths: [24, 9, 18, 11, 11, 11, 9, 11, 11, 12, 14],
  };

  // ---- listings left ----
  const leftSections = [
    { title: 'Listing', color: '1F3864', headers: ['SKU', 'Where', 'Model Name', 'Brand', 'Category'] },
    { title: 'Score', color: '01579B', headers: ['Score', 'Score at Week Start', 'Status'] },
    { title: 'What it takes to reach 100%', color: '1E5631', headers: ['Issues', 'What Is Missing', 'New This Week', 'Fixed This Week'] },
  ];
  const leftRows = [];
  const weekRowsList = [];
  for (const r of rows) {
    const c = compared.get(r.scope.id);
    if (!c) continue;
    for (const l of sortListings(c.rows.filter((x) => x.issues.length > 0), 'closest')) {
      const [sku, ...rest] = productCells(l.sku);
      leftRows.push([
        sku, r.scope.label, ...rest,
        l.score, n(l.before), l.score < BAD_UNDER ? 'Bad' : 'Left to 100%',
        l.issues.length, labels(r.scope, l.issues),
        l.isNew ? '' : labels(r.scope, l.added), labels(r.scope, l.fixed),
      ]);
    }
    if (!c.hasBefore) continue;
    for (const l of c.rows) {
      const reached = l.issues.length === 0 && l.fixed.length > 0;
      const worse = l.added.length > 0 && !l.isNew;
      if (!reached && !worse && !(l.fixed.length > 0)) continue;
      const [sku, ...rest] = productCells(l.sku);
      weekRowsList.push([
        sku, r.scope.label, ...rest,
        reached ? 'Reached 100%' : worse ? 'Got worse' : 'Improved',
        n(l.before), l.score, labels(r.scope, l.fixed), l.isNew ? '' : labels(r.scope, l.added),
      ]);
    }
  }
  const col = (sections, h) => sections.flatMap((s) => s.headers).indexOf(h);
  const leftSheet = {
    name: 'Listings left',
    sections: leftSections,
    rows: leftRows,
    formats: [null, null, null, null, null, 'count', 'count', null, 'count', 'wrap', 'wrap', 'wrap'],
    widths: [14, 22, 30, 10, 20, 9, 11, 14, 9, 70, 36, 36],
    cellColor: (values, c) => (c === col(leftSections, 'Status') && values[c] === 'Bad' ? { fill: BAD_FILL, bold: true } : null),
  };
  const movedSections = [
    { title: 'Listing', color: '1F3864', headers: ['SKU', 'Where', 'Model Name', 'Brand', 'Category'] },
    { title: `In ${week.name}`, color: '01579B', headers: ['Change', 'Score at Week Start', 'Score'] },
    { title: 'Issues', color: '1E5631', headers: ['Fixed', 'New'] },
  ];
  const movedSheet = {
    name: 'This week',
    sections: movedSections,
    rows: weekRowsList,
    formats: [null, null, null, null, null, null, 'count', 'count', 'wrap', 'wrap'],
    widths: [14, 22, 30, 10, 20, 15, 11, 9, 50, 50],
    cellColor: (values, c) => {
      if (c !== col(movedSections, 'Change')) return null;
      return values[c] === 'Got worse' ? { fill: BAD_FILL, bold: true } : { fill: GOOD_FILL, bold: true };
    },
  };

  // ---- by issue ----
  const issueSections = [
    { title: 'Check', color: '1F3864', headers: ['Where', 'Check', 'Fixed In / Kind'] },
    { title: 'Listings', color: '1E5631', headers: ['Listings Failing', 'Change in the Week'] },
  ];
  const issueRows = rows.flatMap((r) => issuesByCheck(r.scope, r.now, r.before).filter((c) => c.count > 0).map((c) => [r.scope.label, c.label, c.where ?? '', c.count, n(c.delta)]));
  const issueSheet = { name: 'By issue', sections: issueSections, rows: issueRows, formats: [null, null, null, 'count', 'count'], widths: [24, 36, 34, 12, 14] };

  // ---- notes ----
  const noDetail = rows.filter((r) => !compared.get(r.scope.id)?.rows.length).map((r) => r.scope.label);
  const notes = {
    name: 'Notes',
    title: 'How to read this file',
    subtitle: 'Analytics → Progress to 100% → Export',
    widths: [30, 118],
    blocks: [
      {
        title: 'The words',
        headers: ['Word', 'Meaning'],
        formats: ['topic', 'wrap'],
        rows: [
          ['Listing', 'A product as it is scored: in the PIM, by the completeness of its own data (Listing Health → PIM); on a marketplace, by that marketplace\'s Listing Health checks.'],
          ['Issue', 'One check one listing fails: a field missing or wrong in the PIM, a failed check on the marketplace. A listing with three failed checks counts three issues.'],
          ['At 100%', 'A listing with no issue.'],
          ['Left', 'The listings that are not at 100% yet.'],
          ['Bad', `A listing scoring under ${BAD_UNDER}: Listing Health's Needs Work and Critical bands.`],
        ],
      },
      {
        title: 'The sheets',
        headers: ['Sheet', 'What it holds'],
        formats: ['topic', 'wrap'],
        rows: [
          ['Summary', `Where the PIM and each marketplace stood in ${week.name}, and what moved in the week.`],
          ['Week by week', 'The same numbers at the end of each of the last 12 weeks. A marketplace\'s listings at 100% and its issues are counted since late November 2026: its earlier weeks have them empty.'],
          ['Listings left', 'Every listing that is not at 100%, the closest to 100% first within each place, with everything it fails. "New This Week" = what it fails now and did not when the week began; "Fixed This Week" = the reverse.'],
          ...(weekRowsList.length ? [['This week', 'The listings that reached 100%, improved or got worse in the week.']] : []),
          ['By issue', 'Each check, how many listings fail it and how that moved in the week. For the PIM, "Fixed In" is the product page\'s tab and section where the field is filled.'],
        ],
      },
      ...(noDetail.length ? [{
        title: 'Not listed yet',
        headers: ['Where', 'Why'],
        formats: ['topic', 'wrap'],
        rows: noDetail.map((label) => [label, 'Its listings are kept from its next snapshot on. Listing Health has the live list meanwhile.']),
      }] : []),
    ],
  };

  return {
    sheets: [summary, weekSheet, ...(leftRows.length ? [leftSheet] : []), ...(weekRowsList.length ? [movedSheet] : []), ...(issueRows.length ? [issueSheet] : []), notes],
    listings: leftRows.length,
  };
}
