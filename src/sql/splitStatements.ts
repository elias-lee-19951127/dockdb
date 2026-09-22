export interface StatementRange {
  text: string;
  /** Offsets in the original text (leading whitespace/comments skipped). */
  start: number;
  end: number;
}

/**
 * Splits a script into statements on `;`, ignoring `;` inside strings,
 * quoted identifiers, comments and Postgres dollar quotes ($$ … $$).
 */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const lead = leadingTrivia(raw);
    const text = raw.slice(lead).trimEnd();
    if (text && !isOnlyComments(text)) out.push({ text, start: start + lead, end: start + lead + text.length });
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      i = indexOrEnd(sql, '\n', i);
    } else if (c === '#' && (i === 0 || /\s/.test(sql[i - 1]))) {
      i = indexOrEnd(sql, '\n', i); // MySQL-style comment
    } else if (c === '/' && next === '*') {
      i = indexOrEnd(sql, '*/', i + 2) + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(sql, i, c);
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) i = indexOrEnd(sql, tag, i + tag.length) + tag.length;
      else i++;
    } else if (c === ';') {
      push(i);
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  push(n);
  return out;
}

function indexOrEnd(s: string, needle: string, from: number): number {
  const j = s.indexOf(needle, from);
  return j < 0 ? s.length : j;
}

function skipQuoted(s: string, i: number, q: string): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\' && q !== '"') j += 2;
    else if (s[j] === q && s[j + 1] === q) j += 2;
    else if (s[j] === q) return j + 1;
    else j++;
  }
  return j;
}

function leadingTrivia(s: string): number {
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith('--', i)) i = indexOrEnd(s, '\n', i);
    else if (s.startsWith('/*', i)) i = indexOrEnd(s, '*/', i) + 2;
    else return Math.min(i, s.length);
  }
}

function isOnlyComments(s: string): boolean {
  return leadingTrivia(s) >= s.length;
}

/** The statement under the cursor; if the cursor is past the last one (blank line), the nearest one before it. */
export function statementAt(statements: StatementRange[], offset: number): StatementRange | undefined {
  const inside = statements.find((s) => offset >= s.start && offset <= s.end + 1);
  if (inside) return inside;
  const before = statements.filter((s) => s.end <= offset);
  return before[before.length - 1] ?? statements[0];
}
