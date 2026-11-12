/**
 * An Excel file the assistant prepared — its description and how a sheet is
 * filled.
 *
 * The implementation lives in supabase/functions/_shared/assistantExcel.js, so
 * the `assistant` edge function (which checks the description and tries each
 * query when the file is prepared) and the browser (which reads every row
 * when the person downloads) fill a sheet with the EXACT same code. This
 * module only re-exports it; change it over there, never here.
 */
export * from '../../../../supabase/functions/_shared/assistantExcel.js';
