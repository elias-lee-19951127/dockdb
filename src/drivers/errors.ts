/**
 * Turns raw database errors into plain-language messages with a hint, for people who do
 * not read SQLSTATE codes for fun. The original message is kept as `detail`.
 */
export interface FriendlyError {
  message: string;
  hint?: string;
  detail?: string;
}

interface RawError {
  code?: string | number;
  errno?: number;
  codeName?: string;
  message?: string;
  detail?: string;
  column?: string;
  table?: string;
  constraint?: string;
  keyValue?: Record<string, unknown>;
}

const q = (s: string | undefined) => (s ? `"${s}"` : 'a column');

export function explainError(e: unknown): FriendlyError {
  const err = (e ?? {}) as RawError;
  const raw = err.message ?? String(e);
  const detail = [raw, err.detail].filter(Boolean).join('\n');
  const code = String(err.code ?? '');
  const errno = err.errno;
  const f = (message: string, hint?: string): FriendlyError => ({ message, hint, detail });

  // ── duplicate value in a unique column ──
  if (code === '23505' || code === 'ER_DUP_ENTRY' || errno === 1062 || code === '11000' || err.code === 11000 || /UNIQUE constraint failed/.test(raw)) {
    const pg = /Key \((.+?)\)=\((.*)\) already exists/.exec(err.detail ?? '');
    const my = /Duplicate entry '(.*)' for key '(?:[^.']+\.)?([^']+)'/.exec(raw);
    const lite = /UNIQUE constraint failed: (?:\w+\.)?([\w, .]+)/.exec(raw);
    const mongo = /dup key: \{ ?(\w+): (.+?) ?\}/.exec(raw);
    const col = pg?.[1] ?? mongo?.[1] ?? lite?.[1] ?? my?.[2];
    const val = pg?.[2] ?? mongo?.[2] ?? my?.[1];
    return f(
      `Duplicate value${col ? ` in ${q(col)}` : ''}${val ? `: ${val}` : ''} — another row already has it.`,
      'This column must be unique. Change the value, or edit the existing row instead of adding a new one.',
    );
  }
  // ── required column left empty ──
  if (code === '23502' || errno === 1048 || errno === 1364 || /NOT NULL constraint failed/.test(raw)) {
    const col = err.column ?? /Column '([^']+)' cannot be null/.exec(raw)?.[1] ?? /Field '([^']+)' doesn't have a default/.exec(raw)?.[1] ?? /NOT NULL constraint failed: (?:\w+\.)?(\w+)/.exec(raw)?.[1];
    return f(`${q(col)} is required and cannot be empty (NULL).`, 'Fill in a value for this column before saving. Required columns are marked with * in the header.');
  }
  // ── foreign keys ──
  if (code === '23503' || errno === 1451 || errno === 1452 || /FOREIGN KEY constraint failed/.test(raw)) {
    const deleting = /still referenced|delete or update a parent row/i.test(`${raw} ${err.detail ?? ''}`) || errno === 1451;
    return deleting
      ? f('Other rows still point to this row, so it cannot be deleted or its key changed.', 'Delete or update the rows that reference it first (they are in another table).')
      : f('This value points to a row that does not exist in the referenced table.', 'Pick a value that exists in the referenced table (see the → badge in the column header).');
  }
  // ── wrong value format ──
  if (code === '22P02' || code === '22007' || code === '22008' || errno === 1366 || errno === 1292) {
    const bad = /invalid input syntax for type (\w[\w ]*): "(.*)"/.exec(raw) ?? /Incorrect (\w+) value: '(.*?)'/.exec(raw);
    return f(
      bad ? `"${bad[2]}" is not a valid ${bad[1]}.` : 'A value has the wrong format for its column.',
      'Check the column type in the header: numbers without letters, dates like 2026-09-22 or 2026-09-22 10:30:00, booleans as true/false.',
    );
  }
  if (code === '22003' || errno === 1264) return f('A number is out of range for its column.', 'Use a smaller value, or check the column type in the header.');
  if (code === '22001' || errno === 1406) return f('A value is too long for its column.', 'Shorten the text — the maximum length is shown in the column type, e.g. varchar(50).');
  if (code === '23514' || errno === 3819 || /CHECK constraint failed/.test(raw)) {
    return f('A value is not allowed by a rule (CHECK constraint) on this table.', 'The rule is defined in the table structure; ask whoever owns the schema what values are allowed.');
  }
  // ── problems in a filter or query ──
  if (code === '42601' || errno === 1064 || /syntax error/i.test(raw)) {
    return f(`The SQL is not valid: ${raw.replace(/^.*?syntax error:?\s*/i, '')}`, 'Tip: use the Search box or the column header menu to filter without writing SQL.');
  }
  if (code === '42703' || errno === 1054 || /no such column/.test(raw)) {
    const col = /column "?([\w.]+)"? does not exist/.exec(raw)?.[1] ?? /Unknown column '([^']+)'/.exec(raw)?.[1] ?? /no such column: ([\w.]+)/.exec(raw)?.[1];
    return f(`There is no column named ${q(col)}.`, 'Column names are case-sensitive in some databases. Copy the exact name from the header.');
  }
  if (code === '42P01' || errno === 1146 || /no such table/.test(raw)) return f('The table does not exist (it may have been renamed or dropped).', 'Refresh the sidebar.');
  if (code === '42501' || errno === 1142 || err.code === 13) return f('Your database user is not allowed to do this.', 'Ask for more privileges, or connect as another user ("Edit Credentials").');
  if (code === '57014' || /maxTimeMS|statement timeout/i.test(raw)) return f('The query took too long and was cancelled.', 'Narrow it down with a filter.');
  return { message: raw };
}
