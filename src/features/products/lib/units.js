import { useCallback, useState } from 'react';

// The PIM stores every length in INCHES — that's what the marketplace exporters
// read, and what the `*_in` attribute keys promise. Switching to centimetres is
// purely a display concern: nothing is ever written to the database in another
// unit, and editing always happens in inches so a round-trip can't drift.

const PER_INCH = { in: 1, cm: 2.54 };
const STORAGE_KEY = 'pim.lengthUnit';

/** Value stored in inches → string in the requested display unit (null if empty). */
export function toDisplayLength(inches, unit = 'in') {
  if (inches == null || inches === '') return null;
  const n = Number(inches);
  if (!Number.isFinite(n)) return String(inches);
  // Inches are shown verbatim: rounding here would turn 16.875 into 16.88.
  if (unit === 'in') return String(inches);
  return String(Math.round(n * PER_INCH[unit] * 100) / 100);
}

/** "External Dimensions" + "cm" → "External Dimensions (cm)". */
export const withUnit = (label, unit) => `${label} (${unit})`;

/**
 * Display unit for lengths, remembered per browser. Returns ['in' | 'cm', setter].
 */
export function useLengthUnit() {
  const [unit, setUnit] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'cm' ? 'cm' : 'in';
    } catch {
      return 'in';
    }
  });

  const choose = useCallback((next) => {
    setUnit(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore storage failures (private mode, etc.) */
    }
  }, []);

  return [unit, choose];
}
