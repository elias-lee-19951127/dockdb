// Placeholder text for the grid's filter box, built from the table's own columns.

const NUMBER = /int|serial|numeric|decimal|real|double|float|money|number|^long$/i;
const TEXT = /char|text|string|clob|citext/i;
const BOOL = /bool|^bit\(1\)$|^tinyint\(1\)$/i;
const SUFFIX = '  (Enter to apply)';

const pick = (cols: { name: string; dataType?: string }[], re: RegExp, skip?: string) =>
  cols.find((c) => c.name !== skip && re.test(c.dataType ?? '') && !BOOL.test(c.dataType ?? ''))?.name;

/** e.g. `id > 10 AND email LIKE '%a%'`, using a numeric and a text column when the table has them. */
export function sqlFilterExample(cols: { name: string; dataType?: string }[], quote: '"' | '`' | '['): string {
  const q = (n: string) => (/^[a-z_][a-z0-9_]*$/i.test(n) ? n : quote === '[' ? `[${n.replace(/]/g, ']]')}]` : quote + n.split(quote).join(quote + quote) + quote);
  const num = pick(cols, NUMBER);
  const text = pick(cols, TEXT, num);
  const parts = [num && `${q(num)} > 10`, text && `${q(text)} LIKE '%a%'`].filter(Boolean);
  if (!parts.length) return `e.g. id > 10 AND email LIKE '%@gmail.com'${SUFFIX}`;
  return `e.g. ${parts.join(' AND ')}${SUFFIX}`;
}

/** e.g. `{ age: { $gt: 18 }, name: /an/i }`, using the collection's own fields. */
export function mongoFilterExample(cols: { name: string; dataType?: string }[]): string {
  const k = (n: string) => (/^[a-z_$][a-z0-9_$]*$/i.test(n) ? n : JSON.stringify(n));
  const fields = cols.filter((c) => c.name !== '_id');
  const num = pick(fields, NUMBER);
  const text = pick(fields, TEXT, num);
  const parts = [num && `${k(num)}: { $gt: 18 }`, text && `${k(text)}: /an/i`].filter(Boolean);
  if (!parts.length) return `e.g. { age: { $gt: 18 }, name: /an/i }${SUFFIX}`;
  return `e.g. { ${parts.join(', ')} }${SUFFIX}`;
}
