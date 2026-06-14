// Generates a readable but strong temporary password using the crypto RNG.
// Excludes ambiguous characters (0/O, 1/l/I) so it can be dictated if needed.
export function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const symbols = '!@#$%&*';
  let out = '';
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 10; i += 1) out += chars[buf[i] % chars.length];
  out += symbols[buf[10] % symbols.length];
  out += chars[buf[11] % chars.length];
  return out;
}
