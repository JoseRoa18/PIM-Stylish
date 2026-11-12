import { useId, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';

// The Lowe's merchant changes often (user, 2026-11-06), so the Item Template's
// "Lowes Merchant Email" is asked at every new-listing export. The exporter
// keeps no default. The last ones typed in this browser are offered as
// suggestions, never filled in on their own.
const RECENT_KEY = 'pim.lowesMerchantEmails';
const RECENT_MAX = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function recentEmails() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rememberEmail(email) {
  try {
    const others = recentEmails().filter((v) => v.toLowerCase() !== email.toLowerCase());
    localStorage.setItem(RECENT_KEY, JSON.stringify([email, ...others].slice(0, RECENT_MAX)));
  } catch {
    // Without storage it only loses the suggestions.
  }
}

export default function LowesMerchantDialog({ onConfirm, onClose }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [recent] = useState(recentEmails);
  const fieldId = useId();
  const listId = useId();
  const errorId = useId();
  const formId = useId();

  function submit(e) {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setError('Enter the merchant\'s email, for example name@lowes.com.');
      return;
    }
    rememberEmail(value);
    onConfirm(value);
  }

  return (
    <Dialog
      onClose={onClose}
      title="Export Lowe's new listing"
      subtitle="Who is the Lowe's merchant for these products? It goes in the Item Template's Lowes Merchant Email column."
      maxWidth="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            Export
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
      {error && (
        <div id={errorId} role="alert" className="mb-4 p-3 rounded-lg bg-error-container/40 border border-error/30 flex items-start gap-2 animate-banner-in">
          <AlertCircle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-body-sm text-error">{error}</p>
        </div>
      )}
      <label htmlFor={fieldId} className="block text-label-md text-on-surface mb-1.5">Lowe's merchant email</label>
      <input
        id={fieldId}
        type="email"
        required
        maxLength={100}
        value={email}
        onChange={(e) => { setEmail(e.target.value); setError(null); }}
        list={recent.length ? listId : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder="name@lowes.com"
        autoComplete="off"
        className="w-full px-3 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
      />
      {recent.length > 0 && (
        <datalist id={listId}>
          {recent.map((v) => <option key={v} value={v} />)}
        </datalist>
      )}
      </form>
    </Dialog>
  );
}
