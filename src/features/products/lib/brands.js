// Single source of truth for the product brands (user rule 2026-09-29: the
// PIM only carries Stylish and Azuni). Every brand input is a dropdown of
// these; imports map any casing onto them and refuse anything else. The
// brand also picks the general warranty (Settings → Warranty documents) and
// the Wix stores that sell the product.
export const BRANDS = ['Stylish', 'Azuni'];

export const BRAND_OPTIONS = BRANDS.map((b) => ({ value: b, label: b }));

/** 'stylish' / 'AZUNI ' → 'Stylish' / 'Azuni'; anything else → null. */
export const canonicalBrand = (value) => BRANDS.find((b) => b.toLowerCase() === String(value ?? '').trim().toLowerCase()) ?? null;
