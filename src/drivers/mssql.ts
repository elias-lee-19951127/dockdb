import sql, { ConnectionPool } from 'mssql';
import { CellValue, ColumnInfo, ConnectionConfig, ForeignKey, QueryResult, Statement, TableRef } from '../model';
import { DIALECTS } from '../sql/dialect';
import { AuthError, DriverTableInfo, RowMismatchError, SqlDriver, TableAccess, toCell } from './driver';
import { SqlTableAccess } from './sqlTable';

const SYSTEM_DBS = new Set(['master', 'tempdb', 'model', 'msdb']);

/** Shape of a `request.query()` result when `arrayRowMode` is set: rows as arrays, columns as a separate array. */
interface ArrayResult {
  recordset: unknown[][];
  columns: { name: string }[][];
  rowsAffected: number[];
}

export class MssqlDriver implements SqlDriver {
  readonly kind = 'mssql' as const;
  readonly queryLanguage = 'sql' as const;
  readonly dialect = DIALECTS.mssql;
  readonly hasSchemas = true;
  readonly defaultDatabase: string;
  private readonly pools = new Map<string, Promise<ConnectionPool>>();

  constructor(private readonly config: ConnectionConfig, private readonly password: string | undefined) {
    this.defaultDatabase = config.database || 'master';
  }

  private pool(database: string): Promise<ConnectionPool> {
    const key = database || this.defaultDatabase;
    let p = this.pools.get(key);
    if (!p) {
      const pool = new sql.ConnectionPool({
        server: this.config.host!,
        port: this.config.port,
        user: this.config.user,
        password: this.password ?? '',
        database: key,
        connectionTimeout: 6000,
        requestTimeout: 15000,
        pool: { max: 3 },
        options: {
          // Local/Docker SQL Server has no real certificate — trust it, same as rejectUnauthorized:false elsewhere.
          encrypt: !!this.config.ssl,
          trustServerCertificate: true,
          enableArithAbort: true,
        },
      });
      pool.on('error', () => undefined); // error on an idle connection — the pool replaces it
      p = pool.connect();
      this.pools.set(key, p);
    }
    return p;
  }

  private wrap(e: unknown): never {
    const err = e as { code?: string; number?: number; message?: string };
    if (err.code === 'ELOGIN' || err.number === 18456) throw new AuthError(err.message ?? 'Wrong user or password');
    throw e;
  }

  async ping(): Promise<string | undefined> {
    const r = await this.query(this.defaultDatabase, 'SELECT @@VERSION');
    return r.rows[0]?.[0]?.split('\n')[0];
  }

  async listDatabases(includeSystem: boolean): Promise<string[]> {
    const r = await this.query(
      this.defaultDatabase,
      `SELECT name FROM sys.databases WHERE state = 0 ORDER BY CASE WHEN name = @p1 THEN 0 ELSE 1 END, name`,
      [this.defaultDatabase],
    );
    return r.rows.map((row) => row[0]!).filter((d) => includeSystem || !SYSTEM_DBS.has(d) || d === this.defaultDatabase);
  }

  async listSchemas(database: string, includeSystem: boolean): Promise<string[]> {
    const r = await this.query(
      database,
      `SELECT name FROM sys.schemas
       WHERE @p1 = 1 OR (name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND name NOT LIKE 'db[_]%')
       ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name`,
      [includeSystem ? '1' : '0'],
    );
    return r.rows.map((row) => row[0]!);
  }

  async listTables(database: string, schema = 'dbo'): Promise<DriverTableInfo[]> {
    const r = await this.query(
      database,
      `SELECT t.name, 'table' AS kind, SUM(p.rows) AS est_rows
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
       WHERE s.name = @p1
       GROUP BY t.name
       UNION ALL
       SELECT v.name, 'view', NULL FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id WHERE s.name = @p1
       ORDER BY name`,
      [schema],
    );
    return r.rows.map(([name, kind, rows]) => ({
      database,
      schema,
      name: name!,
      type: kind === 'view' ? 'view' : 'table',
      estimatedRows: rows !== null ? Number(rows) : undefined,
    }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const schema = table.schema ?? 'dbo';
    const r = await this.query(
      table.database,
      `SELECT c.COLUMN_NAME,
              c.DATA_TYPE +
                CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NULL THEN ''
                     WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN '(MAX)'
                     ELSE '(' + CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR(10)) + ')' END AS data_type,
              c.IS_NULLABLE,
              c.COLUMN_DEFAULT,
              COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS is_identity,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk
       FROM INFORMATION_SCHEMA.COLUMNS c
       LEFT JOIN (
         SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND ku.TABLE_SCHEMA = tc.TABLE_SCHEMA
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
       WHERE c.TABLE_SCHEMA = @p1 AND c.TABLE_NAME = @p2
       ORDER BY c.ORDINAL_POSITION`,
      [schema, table.name],
    );
    return r.rows.map(([name, type, nullable, def, identity, pk]) => ({
      name: name!,
      dataType: type!,
      nullable: nullable === 'YES',
      hasDefault: def !== null || identity === '1',
      isPrimaryKey: pk === '1',
      isAutoIncrement: identity === '1',
    }));
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const schema = table.schema ?? 'dbo';
    const r = await this.query(
      table.database,
      `SELECT kcu1.COLUMN_NAME, kcu2.TABLE_SCHEMA, kcu2.TABLE_NAME, kcu2.COLUMN_NAME
       FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu1 ON kcu1.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND kcu1.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2 ON kcu2.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME AND kcu2.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA
         AND kcu2.ORDINAL_POSITION = kcu1.ORDINAL_POSITION
       WHERE kcu1.TABLE_SCHEMA = @p1 AND kcu1.TABLE_NAME = @p2
         AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k2
              WHERE k2.CONSTRAINT_NAME = kcu1.CONSTRAINT_NAME AND k2.CONSTRAINT_SCHEMA = kcu1.CONSTRAINT_SCHEMA) = 1`,
      [schema, table.name],
    );
    return r.rows.map(([column, refSchema, name, refColumn]) => ({
      column: column!,
      ref: { database: table.database, schema: refSchema!, name: name!, type: 'table' },
      refColumn: refColumn!,
    }));
  }

  async query(database: string, text: string, params: CellValue[] = [], maxRows?: number): Promise<QueryResult> {
    const started = Date.now();
    try {
      const pool = await this.pool(database).catch((e) => this.wrap(e));
      const request = pool.request();
      request.arrayRowMode = true;
      params.forEach((p, i) => request.input(`p${i + 1}`, p));
      const res = (await request.query(text)) as unknown as ArrayResult;
      const cols = res.columns?.[res.columns.length - 1] ?? [];
      const all = res.recordset ?? [];
      const rows = (maxRows && all.length > maxRows ? all.slice(0, maxRows) : all).map((row) => row.map(toCell));
      return {
        columns: cols.map((c) => ({ name: c.name })),
        rows,
        affectedRows: cols.length ? undefined : res.rowsAffected?.reduce((a, b) => a + b, 0),
        durationMs: Date.now() - started,
        truncated: !!maxRows && all.length > maxRows,
      };
    } catch (e) {
      this.wrap(e);
    }
  }

  async transaction(database: string, statements: Statement[]): Promise<number> {
    const pool = await this.pool(database).catch((e) => this.wrap(e));
    const tx = pool.transaction();
    await tx.begin();
    let affected = 0;
    try {
      for (const st of statements) {
        const request = tx.request();
        st.params.forEach((p, i) => request.input(`p${i + 1}`, p));
        const res = await request.query(st.sql);
        const rowsAffected = res.rowsAffected.reduce((a, b) => a + b, 0);
        if (st.expectOneRow && rowsAffected !== 1) throw new RowMismatchError(rowsAffected, st);
        affected += rowsAffected;
      }
      await tx.commit();
      return affected;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }

  openTable(table: TableRef): TableAccess {
    return new SqlTableAccess(this, table);
  }

  qualifiedName(table: TableRef): string {
    return this.dialect.qualified(table);
  }

  sampleQuery(table: TableRef): string {
    return `SELECT TOP (100) * FROM ${this.dialect.qualified(table)};`;
  }

  async close(): Promise<void> {
    const pools = await Promise.all([...this.pools.values()].map((p) => p.catch(() => undefined)));
    await Promise.all(pools.map((p) => p?.close().catch(() => undefined)));
    this.pools.clear();
  }
}
