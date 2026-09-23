import { DbKind, TableRef } from '../model';

export type SqlKind = Exclude<DbKind, 'mongodb'>;

export interface Dialect {
  kind: SqlKind;
  quoteIdent(name: string): string;
  /** Placeholder for the i-th parameter (1-based). */
  placeholder(i: number): string;
  qualified(t: TableRef): string;
  /** NULL-safe equality (used when a table has no primary key). */
  nullSafeEquals(col: string, param: string): string;
  /** Appends this dialect's paging clause to `sql` (which already has its own ORDER BY, if any). */
  paginate(sql: string, hasOrderBy: boolean, limit: number, offset: number): string;
}

const dq = (s: string) => `"${s.replace(/"/g, '""')}"`;
const bq = (s: string) => `\`${s.replace(/`/g, '``')}\``;
const brq = (s: string) => `[${s.replace(/]/g, ']]')}]`;
const limitOffset = (sql: string, _hasOrderBy: boolean, limit: number, offset: number) => `${sql} LIMIT ${limit} OFFSET ${offset}`;

export const DIALECTS: Record<SqlKind, Dialect> = {
  postgres: {
    kind: 'postgres',
    quoteIdent: dq,
    placeholder: (i) => `$${i}`,
    qualified: (t) => (t.schema ? `${dq(t.schema)}.${dq(t.name)}` : dq(t.name)),
    nullSafeEquals: (c, p) => `${c} IS NOT DISTINCT FROM ${p}`,
    paginate: limitOffset,
  },
  mysql: {
    kind: 'mysql',
    quoteIdent: bq,
    placeholder: () => '?',
    qualified: (t) => `${bq(t.database)}.${bq(t.name)}`,
    nullSafeEquals: (c, p) => `${c} <=> ${p}`,
    paginate: limitOffset,
  },
  sqlite: {
    kind: 'sqlite',
    quoteIdent: dq,
    placeholder: () => '?',
    qualified: (t) => dq(t.name),
    nullSafeEquals: (c, p) => `${c} IS ${p}`,
    paginate: limitOffset,
  },
  mssql: {
    kind: 'mssql',
    quoteIdent: brq,
    placeholder: (i) => `@p${i}`,
    qualified: (t) => `${brq(t.schema ?? 'dbo')}.${brq(t.name)}`,
    // No IS DISTINCT FROM / <=> in T-SQL.
    nullSafeEquals: (c, p) => `((${c} = ${p}) OR (${c} IS NULL AND ${p} IS NULL))`,
    // OFFSET/FETCH requires an ORDER BY; synthesize a no-op one when the query has none.
    paginate: (sql, hasOrderBy, limit, offset) => `${sql}${hasOrderBy ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
  },
};
