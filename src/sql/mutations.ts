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

/** A table with no primary key is matched by every column, so an UPDATE/DELETE must be capped at one row. */
function limitOneParts(dialect: Dialect, spec: KeySpec): { prefix: string; suffix: string } {
  if (spec.kind !== 'allColumns') return { prefix: '', suffix: '' };
  if (dialect.kind === 'mysql') return { prefix: '', suffix: ' LIMIT 1' };
  if (dialect.kind === 'mssql') return { prefix: 'TOP (1) ', suffix: '' }; // TOP goes right after UPDATE / before FROM in DELETE
  return { prefix: '', suffix: '' };
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
    const { prefix, suffix } = limitOneParts(dialect, spec);
    if (edit.type === 'update') {
      const sets = Object.entries(edit.set).map(([c, v]) => `${dialect.quoteIdent(c)} = ${params.add(v)}`);
      const where = whereByKey(dialect, spec, edit.key, params);
      return { sql: `UPDATE ${prefix}${target} SET ${sets.join(', ')} WHERE ${where}${suffix}`, params: params.values, expectOneRow: true };
    }
    const where = whereByKey(dialect, spec, edit.key, params);
    return { sql: `DELETE ${prefix}FROM ${target} WHERE ${where}${suffix}`, params: params.values, expectOneRow: true };
  });
}

/** Inlines parameters for preview only — never executed. */
export function renderForPreview(stmt: Statement): string {
  let i = 0;
  const lit = (v: CellValue) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
  return stmt.sql.replace(/\$(\d+)|@p(\d+)|\?/g, (m, n1, n2) => lit(stmt.params[(n1 ?? n2) ? Number(n1 ?? n2) - 1 : i++] ?? null)) + ';';
}
