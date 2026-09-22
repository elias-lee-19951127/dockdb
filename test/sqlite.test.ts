import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteDriver } from '../src/drivers/sqlite';
import { buildStatements, chooseKeySpec } from '../src/sql/mutations';

const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
let file: string;

beforeAll(async () => {
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) });
  const db = new SQL.Database();
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, age INT, bio BLOB);
           INSERT INTO users (email, age) VALUES ('a@x.io', 30), ('b@x.io', NULL);
           CREATE TABLE nokey (a TEXT, b TEXT); INSERT INTO nokey VALUES ('1','2');
           CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users, note TEXT);
           INSERT INTO orders (user_id, note) VALUES (2, 'Giao hàng nhanh'), (1, 'gift wrap');`);
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dockdb-')), 'test.db');
  fs.writeFileSync(file, Buffer.from(db.export()));
});

describe('SqliteDriver', () => {
  it('lists tables and columns, edits and writes to the file', async () => {
    const d = new SqliteDriver({ id: 't', name: 't', kind: 'sqlite', file, source: 'file' }, wasmDir);
    expect((await d.listTables('main')).map((t) => t.name)).toEqual(['nokey', 'orders', 'users']);
    const table = { database: 'main', name: 'users', type: 'table' as const };
    const cols = await d.listColumns(table);
    expect(cols[0]).toMatchObject({ name: 'id', isPrimaryKey: true, isAutoIncrement: true });
    expect(cols[1]).toMatchObject({ name: 'email', nullable: false });

    const spec = chooseKeySpec(d.dialect, table, cols)!;
    const affected = await d.transaction('main', buildStatements(d.dialect, table, spec, [
      { type: 'update', key: ['2'], set: { age: '41' } },
      { type: 'insert', values: { email: 'c@x.io' } },
      { type: 'delete', key: ['1'] },
    ]));
    expect(affected).toBe(3);

    // a fresh driver re-reads the file → the changes were persisted
    const d2 = new SqliteDriver({ id: 't', name: 't', kind: 'sqlite', file, source: 'file' }, wasmDir);
    const r = await d2.query('main', 'SELECT id, email, age FROM users ORDER BY id');
    expect(r.rows).toEqual([['2', 'b@x.io', '41'], ['3', 'c@x.io', null]]);
  });

  it('rolls back when a row no longer exists', async () => {
    const d = new SqliteDriver({ id: 't', name: 't', kind: 'sqlite', file, source: 'file' }, wasmDir);
    const table = { database: 'main', name: 'users', type: 'table' as const };
    const spec = chooseKeySpec(d.dialect, table, await d.listColumns(table))!;
    await expect(d.transaction('main', buildStatements(d.dialect, table, spec, [
      { type: 'update', key: ['2'], set: { age: '99' } },
      { type: 'update', key: ['999'], set: { age: '1' } },
    ]))).rejects.toThrow(/Rolled back/);
    const r = await d.query('main', 'SELECT age FROM users WHERE id = 2');
    expect(r.rows[0][0]).toBe('41');
  });

  it('tables without a PK use rowid', async () => {
    const d = new SqliteDriver({ id: 't', name: 't', kind: 'sqlite', file, source: 'file' }, wasmDir);
    const table = { database: 'main', name: 'nokey', type: 'table' as const };
    const spec = chooseKeySpec(d.dialect, table, await d.listColumns(table))!;
    expect(spec.kind).toBe('pseudo');
    const page = await d.query('main', 'SELECT rowid AS "__dockdb_rowid", "a", "b" FROM "nokey"');
    await d.transaction('main', buildStatements(d.dialect, table, spec, [{ type: 'update', key: [page.rows[0][0]], set: { b: 'z' } }]));
    expect((await d.query('main', 'SELECT b FROM nokey')).rows[0][0]).toBe('z');
  });
});

describe('SqlTableAccess on SQLite', () => {
  const orders = { database: 'main', name: 'orders', type: 'table' as const };

  it('exposes foreign keys on columns', async () => {
    const d = new SqliteDriver({ id: 't', name: 't', kind: 'sqlite', file, source: 'file' }, wasmDir);
    const meta = await d.openTable(orders).meta();
    const col = meta.columns.find((c) => c.name === 'user_id');
    expect(col?.references).toMatchObject({ table: { name: 'users' }, column: 'id' });
  });

  it('plain-text search matches any column, case-insensitively, with parameters', async () => {
    const d = new SqliteDriver({ id: 't', name: 't', kind: 'sqlite', file, source: 'file' }, wasmDir);
    const t = d.openTable(orders);
    await t.meta();
    expect((await t.page('', 'GIFT', null, 50, 0)).rows.map((r) => r[2])).toEqual(['gift wrap']);
    expect((await t.page('', "'; DROP TABLE orders; --", null, 50, 0)).rows).toEqual([]);
    expect(await t.count('user_id = 2', 'hàng')).toBe(1);
    expect((await t.page(t.equalsFilter('user_id', '1'), '', null, 50, 0)).rows).toHaveLength(1);
  });
});
