import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { formatCategory } from '@/lib/format';

export default function FilterDropdown({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (value) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const count = selected.length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-body-sm border transition-colors ${
          count > 0
            ? 'bg-primary-container text-on-primary-container border-primary-container'
            : 'bg-surface-container-lowest text-on-surface border-outline-variant hover:bg-surface-container-low'
        }`}
      >
        <span className="font-semibold">{label}</span>
        {count > 0 && (
          <span className="px-1.5 min-w-[20px] text-center rounded-full bg-primary text-on-primary text-label-md font-semibold">
            {count}
          </span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 min-w-[220px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg overflow-hidden">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-body-sm text-on-surface-variant">
              No options available
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {options.map((option) => {
                const isSelected = selected.includes(option);
                return (
                  <li key={option}>
                    <button
                      type="button"
                      onClick={() => toggle(option)}
                      className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-surface-container-low transition-colors"
                    >
                      <div
                        className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                          isSelected
                            ? 'bg-primary border-primary text-on-primary'
                            : 'border-outline'
                        }`}
                      >
                        {isSelected && (
                          <Check className="w-3 h-3" strokeWidth={3} />
                        )}
                      </div>
                      <span className="text-body-md text-on-surface">
                        {formatCategory(option)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}