export function normalize(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}
