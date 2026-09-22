import { Binary, BSON, BSONRegExp, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID } from 'mongodb';

const { EJSON } = BSON;

export class ShellSyntaxError extends Error {}

const EJSON_WRAPPERS = new Set([
  '$oid',
  '$date',
  '$numberLong',
  '$numberInt',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$timestamp',
  '$minKey',
  '$maxKey',
]);

/**
 * Parser for mongo shell syntax (no eval): plain JSON, unquoted keys,
 * single-quoted strings, comments, /…/i regexes, ObjectId(), ISODate(), NumberLong()…,
 * and Extended JSON ({"$oid": "…"}).
 */
export class Parser {
  i = 0;

  constructor(readonly src: string) {}

  fail(msg: string): never {
    const near = this.src.slice(this.i, this.i + 24).replace(/\s+/g, ' ');
    throw new ShellSyntaxError(`${msg} — near "${near || '(end of input)'}"`);
  }

  ws(): void {
    const s = this.src;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
      if (s.startsWith('//', this.i)) {
        const j = s.indexOf('\n', this.i);
        this.i = j < 0 ? s.length : j;
      } else if (s.startsWith('/*', this.i)) {
        const j = s.indexOf('*/', this.i + 2);
        this.i = j < 0 ? s.length : j + 2;
      } else return;
    }
  }

  peek(): string {
    this.ws();
    return this.src[this.i] ?? '';
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  expect(ch: string): void {
    if (!this.eat(ch)) this.fail(`Expected "${ch}"`);
  }

  atEnd(): boolean {
    this.ws();
    return this.i >= this.src.length;
  }

  ident(): string | undefined {
    this.ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i));
    if (!m) return undefined;
    this.i += m[0].length;
    return m[0];
  }

  value(): unknown {
    const c = this.peek();
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === '/') return this.regex();
    if (c === '-' || c === '+' || c === '.' || /\d/.test(c)) return this.number();
    const start = this.i;
    let id = this.ident();
    if (!id) this.fail('Unexpected value');
    if (id === 'new') id = this.ident() ?? this.fail('Expected a function name after "new"');
    switch (id) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
      case 'undefined':
        return null;
      case 'Infinity':
        return Infinity;
      case 'NaN':
        return NaN;
    }
    if (this.peek() !== '(') {
      this.i = start;
      this.fail(`Unexpected "${id}"`);
    }
    return this.construct(id, this.args());
  }

  args(): unknown[] {
    this.expect('(');
    const out: unknown[] = [];
    while (!this.eat(')')) {
      out.push(this.value());
      if (!this.eat(',')) {
        this.expect(')');
        break;
      }
    }
    return out;
  }

  private object(): Record<string, unknown> {
    this.expect('{');
    const obj: Record<string, unknown> = {};
    while (!this.eat('}')) {
      const c = this.peek();
      let key: string;
      if (c === '"' || c === "'") key = this.string();
      else {
        const m = /^[\w$.-]+/.exec(this.src.slice(this.i));
        if (!m) this.fail('Expected a field name');
        key = m[0];
        this.i += key.length;
      }
      this.expect(':');
      obj[key] = this.value();
      if (!this.eat(',')) {
        this.expect('}');
        break;
      }
    }
    return fromEjsonWrapper(obj) as Record<string, unknown>;
  }

  private array(): unknown[] {
    this.expect('[');
    const out: unknown[] = [];
    while (!this.eat(']')) {
      out.push(this.value());
      if (!this.eat(',')) {
        this.expect(']');
        break;
      }
    }
    return out;
  }

  string(): string {
    const q = this.peek();
    if (q !== '"' && q !== "'") this.fail('Expected a string');
    const s = this.src;
    let out = '';
    this.i++;
    while (this.i < s.length) {
      const ch = s[this.i++];
      if (ch === q) return out;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const e = s[this.i++];
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (e in simple) out += simple[e];
      else if (e === 'u' && s[this.i] === '{') {
        const end = s.indexOf('}', this.i);
        out += String.fromCodePoint(parseInt(s.slice(this.i + 1, end), 16));
        this.i = end + 1;
      } else if (e === 'u') {
        out += String.fromCharCode(parseInt(s.slice(this.i, this.i + 4), 16));
        this.i += 4;
      } else if (e === 'x') {
        out += String.fromCharCode(parseInt(s.slice(this.i, this.i + 2), 16));
        this.i += 2;
      } else out += e;
    }
    this.fail('Unterminated string');
  }

  private number(): number {
    this.ws();
    const m = /^[+-]?(0x[0-9a-f]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?|Infinity)/i.exec(this.src.slice(this.i));
    if (!m) this.fail('Invalid number');
    this.i += m[0].length;
    return Number(m[0]);
  }

  private regex(): BSONRegExp {
    this.ws();
    const s = this.src;
    let j = this.i + 1;
    let inClass = false;
    while (j < s.length) {
      const ch = s[j];
      if (ch === '\\') j += 2;
      else if (ch === '[') (inClass = true), j++;
      else if (ch === ']') (inClass = false), j++;
      else if (ch === '/' && !inClass) break;
      else if (ch === '\n') break;
      else j++;
    }
    if (s[j] !== '/') this.fail('Unterminated regex (missing "/")');
    const pattern = s.slice(this.i + 1, j);
    const flags = /^[a-z]*/.exec(s.slice(j + 1))![0];
    this.i = j + 1 + flags.length;
    return new BSONRegExp(pattern, flags);
  }

  private construct(name: string, args: unknown[]): unknown {
    const a = args[0];
    const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    try {
      switch (name) {
        case 'ObjectId':
        case 'ObjectID':
          return a === undefined ? new ObjectId() : new ObjectId(str(a));
        case 'ISODate':
        case 'Date': {
          const d = a === undefined ? new Date() : a instanceof Date ? a : new Date(a as string | number);
          if (Number.isNaN(d.getTime())) this.fail(`Invalid date: ${str(a)}`);
          return d;
        }
        case 'NumberLong':
        case 'Long':
          return Long.fromString(str(a));
        case 'NumberInt':
        case 'Int32':
          return new Int32(Number(a));
        case 'NumberDecimal':
        case 'Decimal128':
          return Decimal128.fromString(str(a));
        case 'Double':
          return new Double(Number(a));
        case 'UUID':
          return a === undefined ? new UUID() : new UUID(str(a));
        case 'Timestamp':
          return new Timestamp({ t: Number(a), i: Number(args[1] ?? 0) });
        case 'BinData':
          return new Binary(Buffer.from(str(args[1]), 'base64'), Number(a));
        case 'MinKey':
          return new MinKey();
        case 'MaxKey':
          return new MaxKey();
        case 'RegExp':
          return new BSONRegExp(str(a), str(args[1]));
      }
    } catch (e) {
      if (e instanceof ShellSyntaxError) throw e;
      this.fail(`${name}(): ${(e as Error).message}`);
    }
    this.fail(`Unsupported function ${name}()`);
  }
}

/** {"$oid": "…"}, {"$date": …}… → the matching BSON type. */
function fromEjsonWrapper(obj: Record<string, unknown>): unknown {
  const keys = Object.keys(obj);
  if (keys.length < 1 || keys.length > 2 || !EJSON_WRAPPERS.has(keys[0])) return obj;
  try {
    return EJSON.parse(JSON.stringify(obj), { relaxed: false });
  } catch {
    return obj;
  }
}

/** Parses exactly one value; errors on trailing input. */
export function parseLiteral(text: string): unknown {
  const p = new Parser(text);
  const v = p.value();
  p.eat(';');
  if (!p.atEnd()) p.fail('Unexpected trailing input');
  return v;
}

/** Parses a filter/document: must be an object. Empty string → {}. */
export function parseDocument(text: string, what = 'Filter'): Record<string, unknown> {
  if (!text.trim()) return {};
  const v = parseLiteral(text);
  if (!v || typeof v !== 'object' || Array.isArray(v) || '_bsontype' in (v as object)) {
    throw new ShellSyntaxError(`${what} must be an object like { … }`);
  }
  return v as Record<string, unknown>;
}
