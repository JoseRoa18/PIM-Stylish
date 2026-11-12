import { useState } from 'react';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';

// An Excel file the assistant prepared: what it holds (its sheets, with the
// rows each had when it was prepared) and Download. The card keeps only the
// file's description; the rows are read from the PIM when Download is
// pressed, with this person's session (lib/excelFile.js, loaded at that
// moment), so the file is as fresh as the click. It can be downloaded again
// at any time, from this conversation too when it is opened later.

const count = (n) => Number(n ?? 0).toLocaleString('en-US');

export default function FileCard({ file }) {
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(null); // { rows, name }
  const [error, setError] = useState(null);
  const sheets = file.summary?.sheets ?? [];

  async function download() {
    setWorking(true);
    setError(null);
    try {
      const { downloadAssistantFile } = await import('../lib/excelFile');
      setDone(await downloadAssistantFile(file));
    } catch (err) {
      setError(err.message || 'The file could not be made.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <section aria-label={`Excel file: ${file.title}`} className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 space-y-3">
      <div className="flex items-start gap-2">
        <FileSpreadsheet className="w-4 h-4 mt-0.5 flex-shrink-0 text-on-surface" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-label-md text-on-surface-variant">Excel file</p>
          <p className="text-body-md text-on-surface font-medium [overflow-wrap:anywhere]">{file.title}</p>
        </div>
      </div>

      {sheets.length > 0 && (
        <ul className="text-body-sm space-y-1 pl-6">
          {sheets.map((sheet, i) => (
            <li key={`${sheet.name}.${i}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-on-surface [overflow-wrap:anywhere]">{sheet.name}</span>
              <span className="text-on-surface-variant">{count(sheet.rows)} {sheet.rows === 1 ? 'row' : 'rows'} · {count(sheet.columns)} {sheet.columns === 1 ? 'column' : 'columns'}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-6">
        <button
          type="button"
          onClick={download}
          disabled={working}
          aria-label={`Download ${file.title}`}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {working ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />}
          Download
        </button>
        <p className="text-label-sm text-on-surface-variant">
          {done
            ? <span role="status">Downloaded {done.name} — {count(done.rows)} {done.rows === 1 ? 'row' : 'rows'}.</span>
            : 'Its rows are read from the PIM when you download.'}
        </p>
      </div>
      {error && <p role="alert" className="text-body-sm text-error pl-6 [overflow-wrap:anywhere]">{error}</p>}
    </section>
  );
}
