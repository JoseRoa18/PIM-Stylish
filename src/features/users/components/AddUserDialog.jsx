import { useState } from 'react';
import { Loader2, RefreshCw, Copy, Check, AlertCircle } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { createUser } from '../api/users';
import { generatePassword } from '../password';
import { ROLE_OPTIONS } from '../roles';

export default function AddUserDialog({ onClose, onCreated }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('editor');
  const [password, setPassword] = useState(generatePassword);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createUser({ email, password, full_name: fullName, role });
      onCreated?.({ email, password });
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  function copyPassword() {
    navigator.clipboard?.writeText(password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Dialog
      as="form"
      onSubmit={handleSubmit}
      onClose={onClose}
      maxWidth="max-w-lg"
      title="Add team member"
      subtitle="Creates the account with a temporary password. Share both with the person — they can change the password after signing in."
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !email}
            className="px-5 py-2 rounded-full bg-primary text-on-primary text-body-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Create user
          </button>
        </>
      }
    >
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-error-container/40 border border-error/30 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" />
          <p className="text-body-sm text-error">{error}</p>
        </div>
      )}

      <div className="space-y-4">
        <Field label="Email" htmlFor="nu-email">
          <input
            id="nu-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@stylishkb.com"
            className="w-full px-3 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
        </Field>

        <Field label="Full name" htmlFor="nu-name" optional>
          <input
            id="nu-name"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Doe"
            className="w-full px-3 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
        </Field>

        <Field label="Role" htmlFor="nu-role">
          <select
            id="nu-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label} — {r.description}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Temporary password" htmlFor="nu-pass">
          <div className="flex items-center gap-2">
            <input
              id="nu-pass"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1 px-3 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-md font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            <button
              type="button"
              onClick={() => setPassword(generatePassword())}
              title="Generate a new password"
              className="p-2.5 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-container-low transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={copyPassword}
              title="Copy password"
              className="p-2.5 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-container-low transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

function Field({ label, htmlFor, optional, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-label-md text-on-surface-variant mb-1.5">
        {label}
        {optional && <span className="text-on-surface-variant/60"> (optional)</span>}
      </label>
      {children}
    </div>
  );
}
