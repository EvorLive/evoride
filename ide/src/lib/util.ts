// Truncate a long string in the MIDDLE, keeping more of the right side (e.g. the
// deepest folder / the path+port of a URL stays visible).
export function midTruncate(s: string, max = 56): string {
  if (s.length <= max) return s;
  const keepRight = Math.ceil((max - 1) * 0.62);
  const keepLeft = max - 1 - keepRight;
  return `${s.slice(0, keepLeft)}…${s.slice(s.length - keepRight)}`;
}
