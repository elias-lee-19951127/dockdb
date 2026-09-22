import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { CellValue, ColumnInfo, ConnectionConfig, ForeignKey, QueryResult, Statement, TableRef } from '../model';
import { safetyOf } from '../safety';
import { DIALECTS } from '../sql/dialect';
import { DriverTableInfo, RowMismatchError, SqlDriver, TableAccess, toCell } from './driver';
import { SqlTableAccess } from './sqlTable';

let sqlJs: Promise<SqlJsStatic> | undefined;

/** SQLite via sql.js (WASM) → no native module to rebuild per VS Code version. */
export class SqliteDriver implements SqlDriver {
  readonly kind = 'sqlite' as const;
  readonly queryLanguage = 'sql' as const;
  readonly dialect = DIALECTS.sqlite;
  readonly hasSchemas = false;
  readonly defaultDatabase = 'main';
  private db: Database | undefined;
  private loadedMtime = 0;
  /** In-flight load, shared by concurrent callers so one does not close the other's database. */
  private loading: Promise<Database> | undefined;

  constructor(private readonly config: ConnectionConfig, private readonly wasmDir: string) {}

  private async open(): Promise<Database> {
    const mtime = fs.statSync(this.config.file!).mtimeMs;
    // File changed on disk → reload.
    if (this.db && mtime === this.loadedMtime) return this.db;
    this.loading ??= this.load(mtime).finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async load(mtime: number): Promise<Database> {
    sqlJs ??= initSqlJs({ locateFile: (f: string) => path.join(this.wasmDir, f) });
    const SQL = await sqlJs;
    this.db?.close();
    this.db = new SQL.Database(fs.readFileSync(this.config.file!));
    this.loadedMtime = mtime;
    return this.db;
  }

  private persist(db: Database) {
    // Read-only: changes (if any slipped through) stay in memory and never reach the file.
    if (safetyOf(this.config) === 'readonly') return;
    fs.writeFileSync(this.config.file!, Buffer.from(db.export()));
    this.loadedMtime = fs.statSync(this.config.file!).mtimeMs;
  }

  private run(db: Database, sql: string, params: CellValue[], maxRows?: number): QueryResult {
    const started = Date.now();
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: CellValue[][] = [];
      let truncated = false;
      while (stmt.step()) {
        if (maxRows && rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(stmt.get().map(toCell));
      }
      const columns = stmt.getColumnNames().map((name) => ({ name }));
      return {
        columns,
        rows,
        affectedRows: columns.length ? undefined : db.getRowsModified(),
        durationMs: Date.now() - started,
        truncated,
      };
    } finally {
      stmt.free();
    }
  }

  async ping(): Promise<string | undefined> {
    const db = await this.open();
    return String(db.exec('select sqlite_version()')[0]?.values[0]?.[0] ?? '');
  }

  async listDatabases(): Promise<string[]> {
    return ['main'];
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(database: string): Promise<DriverTableInfo[]> {
    const db = await this.open();
    const r = this.run(db, `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`, []);
    return r.rows.map(([name, type]) => ({ database, name: name!, type: type === 'view' ? 'view' : 'table' }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const db = await this.open();
    const r = this.run(db, `PRAGMA table_info(${this.dialect.quoteIdent(table.name)})`, []);
    const pkCount = r.rows.filter((row) => row[5] !== '0').length;
    return r.rows.map(([, name, type, notnull, dflt, pk]) => {
      const isPk = pk !== '0';
      const rowidAlias = isPk && pkCount === 1 && /^integer$/i.test(type ?? '');
      return {
        name: name!,
        dataType: type || 'ANY',
        nullable: notnull === '0' && !isPk,
        hasDefault: dflt !== null || rowidAlias,
        isPrimaryKey: isPk,
        isAutoIncrement: rowidAlias,
      };
    });
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const db = await this.open();
    const r = this.run(db, `PRAGMA foreign_key_list(${this.dialect.quoteIdent(table.name)})`, []);
    // id, seq, table, from, to — keep single-column keys; "to" is empty when it targets the primary key.
    const multi = new Set(r.rows.filter((row) => row[1] !== '0').map((row) => row[0]));
    const out: ForeignKey[] = [];
    for (const [id, , refTable, from, to] of r.rows) {
      if (multi.has(id)) continue;
      const ref: TableRef = { database: table.database, name: refTable!, type: 'table' };
      const refColumn = to ?? (await this.listColumns(ref)).find((c) => c.isPrimaryKey)?.name ?? 'rowid';
      out.push({ column: from!, ref, refColumn });
    }
    return out;
  }

  async query(_database: string, sql: string, params: CellValue[] = [], maxRows?: number): Promise<QueryResult> {
    const db = await this.open();
    const result = this.run(db, sql, params, maxRows);
    if (!/^\s*(select|explain|values|with)\b/i.test(sql)) this.persist(db);
    return result;
  }

  async transaction(_database: string, statements: Statement[]): Promise<number> {
    const db = await this.open();
    let affected = 0;
    db.exec('BEGIN');
    try {
      for (const st of statements) {
        this.run(db, st.sql, st.params);
        const n = db.getRowsModified();
        if (st.expectOneRow && n !== 1) throw new RowMismatchError(n, st);
        affected += n;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.persist(db);
    return affected;
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
    this.db?.close();
    this.db = undefined;
  }
}
