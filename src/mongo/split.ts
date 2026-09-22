import type { StatementRange } from '../sql/splitStatements';

const STARTS_STATEMENT = /^(db\b|show\b|use\b)/;
const REGEX_BEFORE = /[(,:[{=!&|?;]$/;

/**
 * Splits a mongo shell script into commands: on top-level `;`, or on a newline when the
 * next line starts a new command (`db.`, `show`, `use`) — `;` is optional, like mongosh.
 */
export function splitMongo(text: string): StatementRange[] {
  const out: StatementRange[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  let lastSignificant = '';
  const n = text.length;

  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = leadingTrivia(raw);
    const body = raw.slice(lead).trimEnd();
    if (body && leadingTrivia(body) < body.length) out.push({ text: body, start: start + lead, end: start + lead + body.length });
  };

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const j = text.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(text, i, c);
      lastSignificant = c;
      continue;
    }
    if (c === '/' && (lastSignificant === '' || REGEX_BEFORE.test(lastSignificant))) {
      i = skipRegex(text, i);
      lastSignificant = '/';
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      push(i);
      start = i + 1;
      lastSignificant = '';
      i++;
      continue;
    } else if (c === '\n' && depth === 0) {
      const rest = text.slice(i + 1).trimStart();
      // A next line starting with "." continues the chain (e.g. .sort({...})) → do not split.
      if (STARTS_STATEMENT.test(rest) && text.slice(start, i).trim() && !/^\./.test(rest)) {
        push(i);
        start = i + 1;
        lastSignificant = '';
      }
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  push(n);
  return out;
}

function skipQuoted(s: string, i: number, q: string): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') j += 2;
    else if (s[j] === q) return j + 1;
    else if (s[j] === '\n' && q !== '`') return j;
    else j++;
  }
  return j;
}

function skipRegex(s: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < s.length && s[j] !== '\n') {
    if (s[j] === '\\') j += 2;
    else if (s[j] === '[') (inClass = true), j++;
    else if (s[j] === ']') (inClass = false), j++;
    else if (s[j] === '/' && !inClass) return j + 1;
    else j++;
  }
  return j;
}

function leadingTrivia(s: string): number {
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith('//', i)) {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
    } else if (s.startsWith('/*', i)) {
      const j = s.indexOf('*/', i);
      i = j < 0 ? s.length : j + 2;
    } else return Math.min(i, s.length);
  }
}
