/**
 * Segmented in/cm switch for the dimension and weight fields: "in" shows inches
 * and pounds, "cm" centimetres and kilos. Display-only: the PIM keeps storing
 * inches and pounds, so the choice never touches the data (see features/
 * products/lib/units.js). Disabled while editing, where fields always show
 * inches and pounds.
 */
export default function UnitToggle({ value, onChange, disabled = false }) {
  return (
    <div
      role="group"
      aria-label="Units: inches and pounds, or centimetres and kilos"
      title={disabled ? 'Editing always uses inches and pounds' : 'Switch how dimensions and weights are displayed'}
      className={`inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-container ${disabled ? 'opacity-38 pointer-events-none' : ''}`}
    >
      {['in', 'cm'].map((unit) => {
        const active = value === unit;
        return (
          <button
            key={unit}
            type="button"
            onClick={() => onChange(unit)}
            // Really disabled while editing (pointer-events-none alone left
            // the buttons focusable and switchable with Enter / Space).
            disabled={disabled}
            aria-pressed={active}
            className={`px-2.5 py-1 rounded-md text-label-md transition-colors ${
              active
                ? 'bg-surface-container-lowest text-on-surface shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {unit}
          </button>
        );
      })}
    </div>
  );
}
