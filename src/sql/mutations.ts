import { CellValue, ColumnInfo, Statement, TableRef } from '../model';
import { Dialect } from './dialect';

/**
 * How a row is identified when updating/deleting:
 * - pk: by primary key
 * - pseudo: a hidden DB column (Postgres ctid, SQLite rowid)
 * - allColumns: match every column + LIMIT 1 (MySQL table without a primary key)
 */
export type KeySpec =
  | { kind: 'pk'; columns: string[] }
  | { kind: 'pseudo'; selectExpr: string; whereExpr: (param: string) => string }
  | { kind: 'allColumns'; columns: string[] };

export type Edit =
  | { type: 'update'; key: CellValue[]; set: Record<string, CellValue> }
  | { type: 'insert'; values: Record<string, CellValue> }
  | { type: 'delete'; key: CellValue[] };

export const ROWID_ALIAS = '__dockdb_rowid';

export function chooseKeySpec(dialect: Dialect, table: TableRef, columns: ColumnInfo[]): KeySpec | undefined {
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  if (pk.length) return { kind: 'pk', columns: pk };
  if (table.type === 'view') return undefined;
  if (dialect.kind === 'postgres') return { kind: 'pseudo', selectExpr: 'ctid::text', whereExpr: (p) => `ctid = ${p}::tid` };
  if (dialect.kind === 'sqlite') return { kind: 'pseudo', selectExpr: 'rowid', whereExpr: (p) => `rowid = ${p}` };
  return { kind: 'allColumns', columns: columns.map((c) => c.name) };
}

/** SELECT expressions for the key columns, placed before the data columns. */
export function keySelectList(dialect: Dialect, spec: KeySpec): string[] {
  if (spec.kind === 'pseudo') return [`${spec.selectExpr} AS ${dialect.quoteIdent(ROWID_ALIAS)}`];
  return spec.columns.map((c) => dialect.quoteIdent(c));
}

class Params {
  readonly values: CellValue[] = [];
  constructor(private readonly dialect: Dialect) {}
  add(v: CellValue): string {
    this.values.push(v);
    return this.dialect.placeholder(this.values.length);
  }
}

function whereByKey(dialect: Dialect, spec: KeySpec, key: CellValue[], params: Params): string {
  if (spec.kind === 'pseudo') return spec.whereExpr(params.add(key[0]));
  if (spec.kind === 'pk') return spec.columns.map((c, i) => `${dialect.quoteIdent(c)} = ${params.add(key[i])}`).join(' AND ');
  return spec.columns.map((c, i) => dialect.nullSafeEquals(dialect.quoteIdent(c), params.add(key[i]))).join(' AND ');
}

function limitOne(dialect: Dialect, spec: KeySpec): string {
  return spec.kind === 'allColumns' && dialect.kind === 'mysql' ? ' LIMIT 1' : '';
}

export function buildStatements(dialect: Dialect, table: TableRef, spec: KeySpec, edits: Edit[]): Statement[] {
  const target = dialect.qualified(table);
  return edits.map((edit): Statement => {
    const params = new Params(dialect);
    if (edit.type === 'insert') {
      const cols = Object.keys(edit.values);
      if (!cols.length) {
        const sql = dialect.kind === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES`;
        return { sql, params: [] };
      }
      const placeholders = cols.map((c) => params.add(edit.values[c]));
      return {
        sql: `INSERT INTO ${target} (${cols.map((c) => dialect.quoteIdent(c)).join(', ')}) VALUES (${placeholders.join(', ')})`,
        params: params.values,
      };
    }
    if (edit.type === 'update') {
      const sets = Object.entries(edit.set).map(([c, v]) => `${dialect.quoteIdent(c)} = ${params.add(v)}`);
      const where = whereByKey(dialect, spec, edit.key, params);
      return { sql: `UPDATE ${target} SET ${sets.join(', ')} WHERE ${where}${limitOne(dialect, spec)}`, params: params.values, expectOneRow: true };
    }
    const where = whereByKey(dialect, spec, edit.key, params);
    return { sql: `DELETE FROM ${target} WHERE ${where}${limitOne(dialect, spec)}`, params: params.values, expectOneRow: true };
  });
}

/** Inlines parameters for preview only — never executed. */
export function renderForPreview(stmt: Statement): string {
  let i = 0;
  const lit = (v: CellValue) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
  return stmt.sql.replace(/\$(\d+)|\?/g, (m, n) => lit(stmt.params[n ? Number(n) - 1 : i++] ?? null)) + ';';
}
