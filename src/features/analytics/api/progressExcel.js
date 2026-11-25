// Analytics → Progress to 100% → Export. Loaded on click. The numbers are the
// section's own (the daily snapshots); only each marketplace's per-listing
// detail is read here, for the two days the week compares. Nothing is written
// but one Activity Log entry.

import { logActivity } from '@/features/activity/api/activityLog';
import { buildSectionedWorkbook } from '@/features/import/lib/sectionedXlsx';
import { CATEGORY_LABEL } from '@/features/products/lib/completeness';
import { loadChannelDetail } from './kpi';
import { progressFileName, progressSheets } from '../lib/progressExcel';

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Build and download the workbook for the given rows of the section (every
 * one, or a single place); returns { fileName, listings }. `task` (optional
 * taskProgress reporter): the reads 30%, the sheets 10%, the workbook the rest.
 */
export async function downloadProgressExcel({ rows, week, names, task = null }) {
  const channels = rows.filter((r) => r.scope.kind === 'channel');
  const dates = channels.flatMap((r) => [r.nowRow?.snapshot_date, r.beforeRow?.snapshot_date]);
  const detail = await loadChannelDetail(channels.map((r) => r.scope.key), dates);
  task?.progress(0.3);
  const details = new Map(rows.map((r) => [r.scope.id, r.scope.kind === 'pim'
    ? { now: r.nowRow, before: r.beforeRow }
    : { now: detail.get(`${r.scope.key}|${r.nowRow?.snapshot_date}`) ?? null, before: detail.get(`${r.scope.key}|${r.beforeRow?.snapshot_date}`) ?? null }]));
  if (task) await task.step('Building the sheets…');
  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, the person's own day
  const { sheets, listings } = progressSheets({ rows, details, products: names, week, labelOf: { category: (key) => CATEGORY_LABEL[key] ?? key }, date });
  task?.progress(0.4);
  const blob = await buildSectionedWorkbook(sheets, { task: task?.part(0.4, 1) });
  const fileName = progressFileName(rows, week, date);
  downloadBlob(blob, fileName);
  logActivity({
    action: 'export',
    entityType: 'catalog',
    entityId: 'progress',
    target: 'pim',
    summary: `Progress to 100% Excel: ${rows.length === 1 ? rows[0].scope.label : `the PIM and ${channels.length} marketplaces`}, ${week.name} — ${listings} listing${listings === 1 ? '' : 's'} left`,
    metadata: { week: week.key, places: rows.map((r) => r.scope.id), listings },
  });
  return { fileName, listings };
}
