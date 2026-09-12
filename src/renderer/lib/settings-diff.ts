type Json = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const equals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => equals(item, b[index]));
  if (isPlainObject(a) && isPlainObject(b))
    return Object.keys(a).length === Object.keys(b).length
      && Object.keys(a).every((key) => equals(a[key], b[key]));
  return false;
};

/**
 * The settings form saves the keys its draft changed against the snapshot it
 * opened from — never the draft itself. Other writers keep saving into the
 * same files while the page is open (theme picker, update banner, the pi
 * runtime's own settings), and only a diff leaves their keys alone. Objects
 * descend so a touched leaf spares its siblings; scalars and arrays replace
 * wholesale, mirroring the merge on the write side. A key the draft cleared
 * is sent as null: the write path treats null as "remove", and unlike
 * undefined it survives the JSON hop a remote workspace's settings take.
 */
export function settingsDiff(next: Json, base: Json): Json {
  const out: Json = {};
  for (const key of new Set([...Object.keys(next), ...Object.keys(base)])) {
    const before = base[key], after = next[key];
    if (equals(after, before)) continue;
    if (isPlainObject(after) && isPlainObject(before)) out[key] = settingsDiff(after, before);
    else if (after === undefined) out[key] = null;
    else out[key] = after;
  }
  return out;
}
