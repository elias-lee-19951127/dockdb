import type { FilterSpec } from '../grid/protocol';
import { CellValue, ColumnInfo, DbKind, ForeignKey, GridColumn, QueryResult, Sort, Statement, TableRef } from '../model';
import { Dialect } from '../sql/dialect';
import type { Edit } from '../sql/mutations';

export interface DriverTableInfo extends TableRef {
  /** Estimated row count (when the DB provides it cheaply). */
  estimatedRows?: number;
}

export interface TableMeta {
  columns: GridColumn[];
  editable: boolean;
  readOnlyReason?: string;
  sort: Sort | null;
  filter: FilterSpec;
}

export interface TablePage {
  rows: CellValue[][];
  /** Keys identifying each row, sent back on update/delete. */
  keys: CellValue[][];
  hasMore: boolean;
  durationMs: number;
  /** Set when this page revealed new columns (MongoDB has no fixed schema). */
  columns?: GridColumn[];
}

/** Everything the grid does on one table / collection — the grid does not care whether it is SQL or MongoDB. */
export interface TableAccess {
  meta(): Promise<TableMeta>;
  /** `search` is plain text matched against every column; `filter` is SQL WHERE / a Mongo filter. */
  page(filter: string, search: string, sort: Sort | null, limit: number, offset: number): Promise<TablePage>;
  count(filter: string, search: string): Promise<number>;
  /** Filter expression selecting rows where `column` equals `value` (used to follow foreign keys). */
  equalsFilter(column: string, value: string): string;
  /** The statements that saving would run, for preview. */
  preview(edits: Edit[]): { title: string; text: string };
  save(edits: Edit[]): Promise<number>;
  /** The equivalent query, to open in an editor. */
  editorQuery(filter: string, limit: number): string;
}

export type QueryLanguage = 'sql' | 'mongo';

export interface Driver {
  readonly kind: DbKind;
  readonly queryLanguage: QueryLanguage;
  /** Database used by default for new queries. */
  readonly defaultDatabase: string;
  /** Postgres has several schemas per database; the others do not. */
  readonly hasSchemas: boolean;
  /** Opens a test connection to validate credentials; returns the server version. */
  ping(): Promise<string | undefined>;
  listDatabases(includeSystem: boolean): Promise<string[]>;
  listSchemas(database: string, includeSystem: boolean): Promise<string[]>;
  listTables(database: string, schema?: string): Promise<DriverTableInfo[]>;
  /** Runs one statement from the query editor. */
  query(database: string, text: string, params?: CellValue[], maxRows?: number): Promise<QueryResult>;
  openTable(table: TableRef): TableAccess;
  /** Fully qualified name, for copying / use in queries. */
  qualifiedName(table: TableRef): string;
  /** Sample query when opening an editor from a table. */
  sampleQuery(table: TableRef): string;
  close(): Promise<void>;
}

/** Driver for SQL databases. */
export interface SqlDriver extends Driver {
  readonly dialect: Dialect;
  listColumns(table: TableRef): Promise<ColumnInfo[]>;
  /** Single-column foreign keys of a table. */
  listForeignKeys(table: TableRef): Promise<ForeignKey[]>;
  /** Runs statements in one transaction; rolls back if any fails. */
  transaction(database: string, statements: Statement[]): Promise<number>;
}

export class AuthError extends Error {}

export class RowMismatchError extends Error {
  constructor(affected: number, public readonly statement?: Statement) {
    super(`A change affected ${affected} rows instead of 1 — the data may have been changed by someone else. Rolled back; nothing was saved.`);
  }
}

/** Normalizes every value to a string so the grid displays and edits them uniformly. */
export function toCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) {
    const buf = Buffer.from(v);
    const text = buf.toString('utf8');
    // eslint-disable-next-line no-control-regex
    return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(text) && !text.includes('�') ? text : `0x${buf.toString('hex')}`;
  }
  return JSON.stringify(v);
}
