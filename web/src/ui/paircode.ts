/**
 * Display and normalization of the numeric pairing code (ADR-0017): 16 decimal digits,
 * shown as 1234-5678-9012-3456. Input may contain spaces, `-` or full-width dashes; every
 * non-digit is stripped. The server normalizes the same way.
 */

/** Keeps digits only. */
export function normalizePairDigits(s: string): string {
  return s.replace(/\D+/g, '')
}

/** Groups of 4 separated by `-`, at most 16 digits. */
export function formatPairDigits(s: string): string {
  return normalizePairDigits(s)
    .slice(0, 16)
    .replace(/(\d{4})(?=\d)/g, '$1-')
}

export const PAIR_DIGITS_LEN = 16
