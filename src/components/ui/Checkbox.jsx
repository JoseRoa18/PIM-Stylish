import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Custom checkbox matching the app's selection pattern (see the filter
 * dropdowns): an empty border-outline box that fills bg-primary with a
 * white check when selected. Wraps a real <input type="checkbox"> (visually
 * hidden, still focusable) so keyboard and screen-reader behavior come for
 * free — works standalone in table cells, toolbars, and forms.
 *
 * Extra props (`aria-label`, `disabled`, `name`, ...) land on the input.
 */
export default function Checkbox({ checked = false, onChange, className, ...rest }) {
  return (
    <label
      className={cn('relative inline-flex items-center justify-center cursor-pointer', className)}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
        {...rest}
      />
      <span
        aria-hidden="true"
        className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 peer-focus-visible:ring-offset-1 ${
          checked ? 'bg-primary border-primary text-on-primary' : 'border-outline'
        }`}
      >
        {checked && <Check className="w-3 h-3" strokeWidth={3} />}
      </span>
    </label>
  );
}
