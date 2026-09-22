import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, ObjectId, Timestamp, UUID } from 'mongodb';
import { CellValue, GridColumn } from '../model';
import { parseLiteral, ShellSyntaxError } from './literal';

export type BsonTypeName =
  | 'null'
  | 'string'
  | 'int'
  | 'long'
  | 'double'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'objectId'
  | 'object'
  | 'array'
  | 'binary'
  | 'uuid'
  | 'regex'
  | 'timestamp'
  | 'minKey'
  | 'maxKey'
  | 'other';

const INT32_MAX = 2 ** 31 - 1;
const INT32_MIN = -(2 ** 31);

export function bsonType(v: unknown): BsonTypeName {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX ? 'int' : 'double';
    case 'bigint':
      return 'long';
  }
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  if (v instanceof RegExp) return 'regex';
  switch ((v as { _bsontype?: string })._bsontype) {
    case 'ObjectId':
    case 'ObjectID':
      return 'objectId';
    case 'Long':
      return 'long';
    case 'Int32':
      return 'int';
    case 'Double':
      return 'double';
    case 'Decimal128':
      return 'decimal';
    case 'Binary':
      return (v as Binary).sub_type === 4 ? 'uuid' : 'binary';
    case 'BSONRegExp':
      return 'regex';
    case 'Timestamp':
      return 'timestamp';
    case 'MinKey':
      return 'minKey';
    case 'MaxKey':
      return 'maxKey';
    case undefined:
      return 'object';
  }
  return 'other';
}

/**
 * Value → grid cell text. Strings, numbers, dates and ObjectIds are shown bare for readability;
 * objects/arrays and rare types use shell syntax so they can be edited and parsed back.
 */
export function formatCell(v: unknown): CellValue {
  switch (bsonType(v)) {
    case 'null':
      return null;
    case 'string':
      return v as string;
    case 'bool':
    case 'int':
    case 'double':
    case 'long':
    case 'decimal':
      return String(typeof v === 'object' ? (v as { toString(): string }).toString() : v);
    case 'date':
      return Number.isNaN((v as Date).getTime()) ? 'Invalid Date' : (v as Date).toISOString();
    case 'objectId':
      return (v as ObjectId).toHexString();
    case 'uuid':
      return (v as Binary).toUUID().toHexString(true);
    default:
      return toShell(v);
  }
}

/** Value → mongo shell syntax (object/array cells and command previews). */
export function toShell(v: unknown, pretty = false): string {
  const sep = pretty ? ', ' : ',';
  const colon = pretty ? ': ' : ':';
  switch (bsonType(v)) {
    case 'null':
      return 'null';
    case 'string':
      return JSON.stringify(v);
    case 'bool':
      return String(v);
    case 'int':
    case 'double': {
      const n = typeof v === 'number' ? v : (v as Int32 | Double).value;
      return Number.isFinite(n) ? String(n) : Number.isNaN(n) ? 'NaN' : n > 0 ? 'Infinity' : '-Infinity';
    }
    case 'long':
      return `NumberLong("${String(v)}")`;
    case 'decimal':
      return `NumberDecimal("${(v as Decimal128).toString()}")`;
    case 'date':
      return `ISODate("${formatCell(v)}")`;
    case 'objectId':
      return `ObjectId("${(v as ObjectId).toHexString()}")`;
    case 'uuid':
      return `UUID("${(v as Binary).toUUID().toHexString(true)}")`;
    case 'binary':
      return `BinData(${(v as Binary).sub_type}, "${Buffer.from((v as Binary).buffer).toString('base64')}")`;
    case 'regex':
      return v instanceof RegExp ? String(v) : `/${(v as BSONRegExp).pattern}/${(v as BSONRegExp).options}`;
    case 'timestamp':
      return `Timestamp(${(v as Timestamp).t}, ${(v as Timestamp).i})`;
    case 'minKey':
      return 'MinKey()';
    case 'maxKey':
      return 'MaxKey()';
    case 'array':
      return `[${(v as unknown[]).map((x) => toShell(x, pretty)).join(sep)}]`;
    case 'object':
      return `{${Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${JSON.stringify(k)}${colon}${toShell(x, pretty)}`)
        .join(sep)}}`;
    default:
      return JSON.stringify(v) ?? 'null';
  }
}

const unwrap = (text: string, fn: string) => new RegExp(`^\\s*${fn}\\(\\s*["']?(.*?)["']?\\s*\\)\\s*$`).exec(text)?.[1] ?? text.trim();
const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

/**
 * Edited cell text → BSON value, keeping the field's original type (`hint`).
 * Unknown types are guessed: object/array/ObjectId(…)/number/true/false, otherwise a string.
 */
export function parseCell(text: CellValue, hint: BsonTypeName | undefined): unknown {
  if (text === null) return null;
  const t = text.trim();
  const bad = (what: string): never => {
    throw new ShellSyntaxError(`"${text}" is not ${what}`);
  };
  switch (hint) {
    case 'string':
      return text;
    case 'int':
    case 'double': {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) bad('a number');
      const n = Number(t);
      if (hint === 'int' && Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX) return new Int32(n);
      return new Double(n);
    }
    case 'long':
      if (!/^-?\d+$/.test(unwrap(t, 'NumberLong'))) bad('an integer');
      return Long.fromString(unwrap(t, 'NumberLong'));
    case 'decimal':
      try {
        return Decimal128.fromString(unwrap(t, 'NumberDecimal'));
      } catch {
        return bad('a decimal number');
      }
    case 'bool':
      if (/^(true|t|1|yes)$/i.test(t)) return true;
      if (/^(false|f|0|no)$/i.test(t)) return false;
      return bad('true/false');
    case 'date': {
      const d = new Date(unwrap(t, 'ISODate'));
      return Number.isNaN(d.getTime()) ? bad('a date/time (e.g. 2026-09-22T10:00:00Z)') : d;
    }
    case 'objectId':
      if (!/^[0-9a-f]{24}$/i.test(unwrap(t, 'ObjectId'))) bad('an ObjectId (24 hex characters)');
      return new ObjectId(unwrap(t, 'ObjectId'));
    case 'uuid':
      try {
        return new UUID(unwrap(t, 'UUID'));
      } catch {
        return bad('UUID');
      }
    case 'object':
    case 'array':
    case 'binary':
    case 'regex':
    case 'timestamp':
    case 'minKey':
    case 'maxKey':
      return parseLiteral(text);
  }
  // Unknown type → guess.
  if (/^[[{/]/.test(t) || /^[A-Za-z]+\(.*\)$/s.test(t)) {
    try {
      return parseLiteral(t);
    } catch {
      return text;
    }
  }
  if (t === 'true' || t === 'false') return t === 'true';
  if (PLAIN_NUMBER.test(t)) return Number(t);
  return text;
}

/** Infers columns from sample documents: `_id` first, then in order of appearance. */
export class ColumnModel {
  private readonly order: string[] = ['_id'];
  private readonly types = new Map<string, Map<BsonTypeName, number>>();

  /** Returns true if new columns appeared. */
  absorb(docs: Record<string, unknown>[]): boolean {
    const before = this.order.length;
    for (const doc of docs) {
      for (const [k, v] of Object.entries(doc)) {
        if (!this.types.has(k)) {
          this.types.set(k, new Map());
          if (!this.order.includes(k)) this.order.push(k);
        }
        const t = bsonType(v);
        const m = this.types.get(k)!;
        m.set(t, (m.get(t) ?? 0) + 1);
      }
    }
    return this.order.length !== before;
  }

  names(): string[] {
    return this.order;
  }

  /** The column's dominant type (ignoring null); several types → undefined. */
  typeOf(column: string): BsonTypeName | undefined {
    const kinds = [...(this.types.get(column)?.keys() ?? [])].filter((t) => t !== 'null');
    return kinds.length === 1 ? kinds[0] : undefined;
  }

  gridColumns(): GridColumn[] {
    return this.order.map((name) => {
      const kinds = [...(this.types.get(name)?.keys() ?? [])].filter((t) => t !== 'null');
      const isId = name === '_id';
      return {
        name,
        dataType: kinds.length === 0 ? (isId ? 'objectId' : 'null') : kinds.length === 1 ? kinds[0] : 'mixed',
        isPrimaryKey: isId,
        hasDefault: isId,
        isAutoIncrement: isId,
        nullable: !isId,
      };
    });
  }
}
