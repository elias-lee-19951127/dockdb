import { Pool, PoolConfig } from 'pg';
import { CellValue, ColumnInfo, ConnectionConfig, ForeignKey, QueryResult, Statement, TableRef } from '../model';
import { safetyOf } from '../safety';
import { DIALECTS } from '../sql/dialect';
import { AuthError, DriverTableInfo, RowMismatchError, SqlDriver, TableAccess, toCell } from './driver';
import { SqlTableAccess } from './sqlTable';

// Keep the server's text representation: no precision loss for bigint/numeric,
// timestamps keep their exact format, and edited values round-trip unchanged.
const RAW_TYPES = { getTypeParser: () => (v: string) => v } as unknown as PoolConfig['types'];

const t = (v: CellValue) => v === 't' || v === 'true';

export class PostgresDriver implements SqlDriver {
  readonly kind = 'postgres' as const;
  readonly queryLanguage = 'sql' as const;
  readonly dialect = DIALECTS.postgres;
  readonly hasSchemas = true;
  readonly defaultDatabase: string;
  private readonly pools = new Map<string, Pool>();

  constructor(private readonly config: ConnectionConfig, private readonly password: string | undefined) {
    this.defaultDatabase = config.database || config.user || 'postgres';
  }

  private pool(database: string): Pool {
    let pool = this.pools.get(database);
    if (!pool) {
      pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.password ?? '',
        database,
        max: 3,
        idleTimeoutMillis: 60_000,
        connectionTimeoutMillis: 6000,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
        types: RAW_TYPES,
        application_name: 'DockDB',
        // Read-only connections: the server itself refuses writes (defense in depth).
        options: safetyOf(this.config) === 'readonly' ? '-c default_transaction_read_only=on' : undefined,
      });
      pool.on('error', () => undefined); // error on an idle client — the pool replaces it
      this.pools.set(database, pool);
    }
    return pool;
  }

  private wrap(e: unknown): never {
    const err = e as { code?: string; message?: string };
    if (err.code === '28P01' || err.code === '28000') throw new AuthError(err.message ?? 'Wrong user or password');
    throw e;
  }

  async ping(): Promise<string | undefined> {
    const r = await this.query(this.defaultDatabase, 'SHOW server_version');
    return r.rows[0]?.[0] ?? undefined;
  }

  async listDatabases(includeSystem: boolean): Promise<string[]> {
    try {
      const r = await this.query(this.defaultDatabase, `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname = $1 DESC, datname`, [this.defaultDatabase]);
      return r.rows.map((row) => row[0]!).filter((d) => includeSystem || d !== 'postgres' || d === this.defaultDatabase);
    } catch {
      return [this.defaultDatabase];
    }
  }

  async listSchemas(database: string, includeSystem: boolean): Promise<string[]> {
    const r = await this.query(
      database,
      `SELECT nspname FROM pg_namespace
       WHERE $1 OR (nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema')
       ORDER BY nspname = 'public' DESC, nspname`,
      [includeSystem ? 'true' : 'false'],
    );
    return r.rows.map((row) => row[0]!);
  }

  async listTables(database: string, schema = 'public'): Promise<DriverTableInfo[]> {
    const r = await this.query(
      database,
      `SELECT c.relname, c.relkind, c.reltuples::bigint
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')
       ORDER BY c.relname`,
      [schema],
    );
    return r.rows.map(([name, kind, rows]) => ({
      database,
      schema,
      name: name!,
      type: kind === 'v' || kind === 'm' ? 'view' : 'table',
      estimatedRows: rows !== null && Number(rows) >= 0 ? Number(rows) : undefined,
    }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const r = await this.query(
      table.database,
      `SELECT a.attname,
              format_type(a.atttypid, a.atttypmod),
              NOT a.attnotnull,
              a.atthasdef,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)),
              a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false)
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [this.dialect.qualified(table)],
    );
    return r.rows.map(([name, type, nullable, hasDef, pk, auto]) => ({
      name: name!,
      dataType: type!,
      nullable: t(nullable),
      hasDefault: t(hasDef) || t(auto),
      isPrimaryKey: t(pk),
      isAutoIncrement: t(auto),
    }));
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const r = await this.query(
      table.database,
      `SELECT a.attname, ns.nspname, cl.relname, af.attname
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.confrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
       WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND array_length(c.conkey, 1) = 1`,
      [this.dialect.qualified(table)],
    );
    return r.rows.map(([column, schema, name, refColumn]) => ({
      column: column!,
      ref: { database: table.database, schema: schema!, name: name!, type: 'table' },
      refColumn: refColumn!,
    }));
  }

  async query(database: string, sql: string, params: CellValue[] = [], maxRows?: number): Promise<QueryResult> {
    const started = Date.now();
    try {
      const res = await this.pool(database).query({ text: sql, values: params, rowMode: 'array' });
      // Multi-statement scripts (no params) return an array — take the last one with rows.
      const r = Array.isArray(res) ? [...res].reverse().find((x) => x.fields?.length) ?? res[res.length - 1] : res;
      const all = (r.rows ?? []) as unknown[][];
      const rows = (maxRows && all.length > maxRows ? all.slice(0, maxRows) : all).map((row) => row.map(toCell));
      return {
        columns: (r.fields ?? []).map((f: { name: string }) => ({ name: f.name })),
        rows,
        affectedRows: r.fields?.length ? undefined : r.rowCount ?? undefined,
        command: r.command,
        durationMs: Date.now() - started,
        truncated: !!maxRows && all.length > maxRows,
      };
    } catch (e) {
      this.wrap(e);
    }
  }

  async transaction(database: string, statements: Statement[]): Promise<number> {
    const client = await this.pool(database).connect().catch((e) => this.wrap(e));
    let affected = 0;
    try {
      await client.query('BEGIN');
      for (const st of statements) {
        const r = await client.query(st.sql, st.params);
        if (st.expectOneRow && r.rowCount !== 1) throw new RowMismatchError(r.rowCount ?? 0, st);
        affected += r.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return affected;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  openTable(table: TableRef): TableAccess {
    return new SqlTableAccess(this, table);
  }

  qualifiedName(table: TableRef): string {
    return this.dialect.qualified(table);
  }

  sampleQuery(table: TableRef): string {
    return `SELECT * FROM ${this.dialect.qualified(table)} LIMIT 100;`;
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}
