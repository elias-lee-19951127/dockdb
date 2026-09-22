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
}

const dq = (s: string) => `"${s.replace(/"/g, '""')}"`;
const bq = (s: string) => `\`${s.replace(/`/g, '``')}\``;

export const DIALECTS: Record<SqlKind, Dialect> = {
  postgres: {
    kind: 'postgres',
    quoteIdent: dq,
    placeholder: (i) => `$${i}`,
    qualified: (t) => (t.schema ? `${dq(t.schema)}.${dq(t.name)}` : dq(t.name)),
    nullSafeEquals: (c, p) => `${c} IS NOT DISTINCT FROM ${p}`,
  },
  mysql: {
    kind: 'mysql',
    quoteIdent: bq,
    placeholder: () => '?',
    qualified: (t) => `${bq(t.database)}.${bq(t.name)}`,
    nullSafeEquals: (c, p) => `${c} <=> ${p}`,
  },
  sqlite: {
    kind: 'sqlite',
    quoteIdent: dq,
    placeholder: () => '?',
    qualified: (t) => dq(t.name),
    nullSafeEquals: (c, p) => `${c} IS ${p}`,
  },
};
