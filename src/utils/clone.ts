/**
 * Deep-clone a value for snapshot isolation. Prefers structuredClone (Node 17+,
 * modern browsers, Hermes 0.72+) and falls back to JSON for older runtimes.
 * Flow state is already constrained to serializable shapes.
 */
export function deepClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  const sc = (globalThis as { structuredClone?: <V>(v: V) => V }).structuredClone;
  if (typeof sc === 'function') {
    return sc(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
