import { useState } from 'react';
import { Lock, AlertCircle } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import { Eye, EyeOff } from 'lucide';

// One password field for the sign-in pages and Settings → Security: its label,
// what it asks for ABOVE the box (a phone's keyboard and a password manager's
// menu cover what is under it), the eye to check what was typed — which is why
// no form asks for a password twice — and its error under it. The error is
// named in aria-describedby only while it shows, so a screen reader hears it
// with the field and never from an empty page.
const LOOK = {
  // The sign-in card: a lock inside the box, like its email field.
  auth: {
    label: 'block text-body-sm font-medium text-on-surface mb-1.5',
    input: 'w-full pl-10 pr-10 py-2.5 rounded-lg border bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:bg-surface-container-low disabled:text-on-surface-variant',
  },
  // Settings' own field.
  settings: {
    label: 'block text-label-lg font-medium text-on-surface mb-1.5',
    input: 'w-full pl-3 pr-10 py-2 rounded-lg border bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:bg-surface-container-low disabled:text-on-surface-variant',
  },
};

export default function PasswordField({
  ref,
  id,
  label,
  hint = null,
  error = null,
  value,
  onChange,
  onBlur,
  autoComplete,
  disabled = false,
  placeholder,
  variant = 'settings',
  enterKeyHint,
  autoFocus = false,
}) {
  const [shown, setShown] = useState(false);
  const look = LOOK[variant] ?? LOOK.settings;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={id} className={look.label}>{label}</label>
      {hint && <p id={hintId} className="text-body-sm text-on-surface-variant -mt-1 mb-1.5">{hint}</p>}
      <div className="relative">
        {variant === 'auth' && (
          <Lock aria-hidden className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
        )}
        <input
          ref={ref}
          id={id}
          name={id}
          type={shown ? 'text' : 'password'}
          required
          autoComplete={autoComplete}
          // A password is not prose: nothing may "correct" it.
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint={enterKeyHint}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={error ? true : false}
          aria-describedby={describedBy}
          className={`${look.input} ${error ? 'border-error' : 'border-outline-variant'}`}
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          // 24px target around the 16px eye.
          className="absolute right-2 p-1 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <MorphIcon icon={shown ? EyeOff : Eye} size={16} reducedMotion="user" />
        </button>
      </div>
      {error && (
        <p id={errorId} className="mt-1.5 text-body-sm text-error flex items-start gap-1.5">
          <AlertCircle aria-hidden className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span><span className="sr-only">Error: </span>{error}</span>
        </p>
      )}
    </div>
  );
}
