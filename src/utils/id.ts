/**
 * Generate a URL-safe random id. Uses Web Crypto where available (Node 18+,
 * modern browsers, Hermes via polyfill); falls back to Math.random.
 */
export function generateId(prefix = 'flow'): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto?.randomUUID) {
    return `${prefix}_${globalCrypto.randomUUID()}`;
  }
  if (globalCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalCrypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}_${hex}`;
  }
  let rand = '';
  for (let i = 0; i < 32; i++) {
    rand += Math.floor(Math.random() * 16).toString(16);
  }
  return `${prefix}_${rand}`;
}
