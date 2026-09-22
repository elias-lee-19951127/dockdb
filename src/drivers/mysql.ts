import mysql, { FieldPacket, Pool, ResultSetHeader } from 'mysql2/promise';
import { CellValue, ColumnInfo, ConnectionConfig, ForeignKey, QueryResult, Statement, TableRef } from '../model';
import { safetyOf } from '../safety';
import { DIALECTS } from '../sql/dialect';
import { AuthError, DriverTableInfo, RowMismatchError, SqlDriver, TableAccess, toCell } from './driver';
import { SqlTableAccess } from './sqlTable';

const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const NO_DB = '';

export class MysqlDriver implements SqlDriver {
  readonly kind = 'mysql' as const;
  readonly queryLanguage = 'sql' as const;
  readonly dialect = DIALECTS.mysql;
  readonly hasSchemas = false;
  readonly defaultDatabase: string;
  private readonly pools = new Map<string, Pool>();

  constructor(private readonly config: ConnectionConfig, private readonly password: string | undefined) {
    this.defaultDatabase = config.database ?? NO_DB;
  }

  private pool(database: string): Pool {
    let pool = this.pools.get(database);
    if (!pool) {
      pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.password ?? '',
        database: database || undefined,
        connectionLimit: 3,
        connectTimeout: 6000,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        multipleStatements: false,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      });
      // Read-only connections: the server itself refuses writes (defense in depth).
      if (safetyOf(this.config) === 'readonly') {
        pool.pool.on('connection', (conn) => conn.query('SET SESSION TRANSACTION READ ONLY'));
      }
      this.pools.set(database, pool);
    }
    return pool;
  }

  private wrap(e: unknown): never {
    const err = e as { code?: string; message?: string };
    if (err.code === 'ER_ACCESS_DENIED_ERROR' || err.code === 'ER_DBACCESS_DENIED_ERROR') throw new AuthError(err.message ?? 'Wrong user or password');
    throw e;
  }

  async ping(): Promise<string | undefined> {
    const r = await this.query(this.defaultDatabase, 'SELECT VERSION()');
    return r.rows[0]?.[0] ?? undefined;
  }

  async listDatabases(includeSystem: boolean): Promise<string[]> {
    const r = await this.query(NO_DB, 'SHOW DATABASES');
    const dbs = r.rows.map((row) => row[0]!).filter((d) => includeSystem || !SYSTEM_DBS.has(d));
    return dbs.sort((a, b) => Number(b === this.defaultDatabase) - Number(a === this.defaultDatabase) || a.localeCompare(b));
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(database: string): Promise<DriverTableInfo[]> {
    const r = await this.query(
      NO_DB,
      'SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database],
    );
    return r.rows.map(([name, type, rows]) => ({
      database,
      name: name!,
      type: type === 'VIEW' || type === 'SYSTEM VIEW' ? 'view' : 'table',
      estimatedRows: rows !== null ? Number(rows) : undefined,
    }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const r = await this.query(
      NO_DB,
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT IS NOT NULL, COLUMN_KEY, EXTRA
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [table.database, table.name],
    );
    return r.rows.map(([name, type, nullable, hasDef, key, extra]) => {
      const auto = /auto_increment/i.test(extra ?? '');
      return {
        name: name!,
        dataType: type!,
        nullable: nullable === 'YES',
        hasDefault: hasDef === '1' || auto || /DEFAULT_GENERATED|VIRTUAL|STORED/i.test(extra ?? ''),
        isPrimaryKey: key === 'PRI',
        isAutoIncrement: auto,
      };
    });
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const r = await this.query(
      NO_DB,
      `SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE k
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
         AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k2
              WHERE k2.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND k2.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND k2.TABLE_NAME = k.TABLE_NAME) = 1`,
      [table.database, table.name],
    );
    return r.rows.map(([column, db, name, refColumn]) => ({
      column: column!,
      ref: { database: db!, name: name!, type: 'table' },
      refColumn: refColumn!,
    }));
  }

  async query(database: string, sql: string, params: CellValue[] = [], maxRows?: number): Promise<QueryResult> {
    const started = Date.now();
    try {
      const [res, fields] = (await this.pool(database).query({ sql, rowsAsArray: true }, params)) as [unknown, FieldPacket[] | undefined];
      if (!Array.isArray(res)) {
        const h = res as ResultSetHeader;
        return { columns: [], rows: [], affectedRows: h.affectedRows, durationMs: Date.now() - started };
      }
      const all = res as unknown[][];
      const rows = (maxRows && all.length > maxRows ? all.slice(0, maxRows) : all).map((row) => row.map(toCell));
      return {
        columns: (fields ?? []).map((f) => ({ name: f.name })),
        rows,
        durationMs: Date.now() - started,
        truncated: !!maxRows && all.length > maxRows,
      };
    } catch (e) {
      this.wrap(e);
    }
  }

  async transaction(database: string, statements: Statement[]): Promise<number> {
    const conn = await this.pool(database).getConnection().catch((e) => this.wrap(e));
    let affected = 0;
    try {
      await conn.beginTransaction();
      for (const st of statements) {
        const [h] = (await conn.query(st.sql, st.params)) as [ResultSetHeader, unknown];
        if (st.expectOneRow && h.affectedRows !== 1) throw new RowMismatchError(h.affectedRows, st);
        affected += h.affectedRows;
      }
      await conn.commit();
      return affected;
    } catch (e) {
      await conn.rollback().catch(() => undefined);
      throw e;
    } finally {
      conn.release();
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
