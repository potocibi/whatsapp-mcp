// One definition of "which phone number is this", shared by the guard chain and the transport.
//
// This exists because they used to have two. The sender reduced a recipient to digits; the
// live session additionally prepended WA_DEFAULT_COUNTRY to a bare local number. With a
// country code configured, a blocklist holding 6591234567 did not match a caller asking to
// message 91234567 - the guard passed, and the transport then dialled the blocklisted number.
// A guard that decides on a different value from the one actually used is not a guard, so
// there is now exactly one function and both sides call it.

/**
 * Digits only, with a default country code applied to bare local numbers.
 *
 * @param {string|number} raw
 * @param {string} [defaultCountry] digits, e.g. '65'. Empty means leave the number alone.
 * @returns {string} digits, or '' if there was nothing usable
 */
export function normaliseNumber(raw, defaultCountry = '') {
  const d = String(raw ?? '').replace(/[^0-9]/g, '');
  if (!d) return '';
  const cc = String(defaultCountry || '').replace(/[^0-9]/g, '');
  return (cc && d.length <= 10 && !d.startsWith(cc)) ? cc + d : d;
}
