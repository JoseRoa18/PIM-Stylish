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

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * A stored decimal length in inches → the fraction retailers print on their
 * sheets: 8.875 → "8 7/8", 4.5 → "4 1/2", 14 → "14".
 *
 * Snapping to the nearest 1/16 is what makes this reliable on real data, where
 * measurements are routinely stored truncated to two decimals — 12.62 is
 * really 12 5/8 and 14.37 is 14 3/8. Rounding recovers the intended fraction
 * instead of inventing a 1/50th.
 *
 * Derived, never stored: the decimal stays the single source of truth, so the
 * two can't drift apart.
 */
export function toFractionLength(inches, denominator = 16) {
  if (inches == null || inches === '') return null;
  const n = Number(inches);
  if (!Number.isFinite(n)) return null;

  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  let whole = Math.floor(abs);
  let num = Math.round((abs - whole) * denominator);

  // Rounding up from .97-ish carries into the whole number.
  if (num === denominator) {
    whole += 1;
    num = 0;
  }
  if (num === 0) return `${sign}${whole}`;

  const d = gcd(num, denominator);
  const fraction = `${num / d}/${denominator / d}`;
  return whole === 0 ? `${sign}${fraction}` : `${sign}${whole} ${fraction}`;
}

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
