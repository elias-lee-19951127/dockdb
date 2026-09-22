import { describe, expect, it } from 'vitest';
import { isWriteMongo, isWriteSql, safetyOf } from '../src/safety';

describe('isWriteSql', () => {
  it('reads', () => {
    for (const sql of [
      'SELECT * FROM users',
      '  -- note\n select replace(name, \'a\', \'b\') from t',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      "SELECT 'delete from users' AS text",
      'SELECT * FROM t FOR UPDATE',
      'SELECT created_at, updated_by FROM t',
      'EXPLAIN SELECT 1',
      'SHOW TABLES',
      'PRAGMA table_info(users)',
      'SET search_path TO app',
      '(SELECT 1)',
    ]) expect(isWriteSql(sql), sql).toBe(false);
  });

  it('writes', () => {
    for (const sql of [
      'UPDATE users SET a = 1',
      'delete from users',
      'INSERT INTO t VALUES (1)',
      'DROP TABLE t',
      'CREATE INDEX i ON t(a)',
      'TRUNCATE t',
      'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
      'SELECT * INTO backup FROM users',
      'EXPLAIN ANALYZE DELETE FROM t',
      'PRAGMA user_version = 2',
      'SET default_transaction_read_only = off',
      'CALL do_things()',
      'GRANT ALL ON t TO bob',
      'VACUUM',
    ]) expect(isWriteSql(sql), sql).toBe(true);
  });
});

describe('isWriteMongo', () => {
  it('reads', () => {
    for (const cmd of [
      'db.users.find({ a: 1 }).sort({ a: -1 }).limit(5)',
      'db.users.aggregate([{ $match: {} }, { $group: { _id: "$a" } }])',
      'db.users.countDocuments({})',
      'db.runCommand({ ping: 1 })',
      'show collections',
      'db.users.getIndexes()',
    ]) expect(isWriteMongo(cmd), cmd).toBe(false);
  });

  it('writes', () => {
    for (const cmd of [
      'db.users.insertOne({ a: 1 })',
      'db.users.updateMany({}, { $set: { a: 1 } })',
      'db.users.deleteMany({})',
      'db.users.drop()',
      'db.users.aggregate([{ $match: {} }, { $out: "copy" }])',
      'db.users.aggregate([{ $merge: { into: "x" } }])',
      'db.runCommand({ drop: "users" })',
      'db.dropDatabase()',
      'db.users.createIndex({ a: 1 })',
      'db.users.findOneAndUpdate({}, { $set: { a: 1 } })',
    ]) expect(isWriteMongo(cmd), cmd).toBe(true);
  });
});

describe('safetyOf', () => {
  const base = { id: 'x', name: 'x', kind: 'postgres' as const, source: 'manual' as const };
  it('defaults: local and Docker are Dev, remote is Protected, explicit wins', () => {
    expect(safetyOf({ ...base, host: '127.0.0.1' })).toBe('dev');
    expect(safetyOf({ ...base, host: 'db.internal.company.com' })).toBe('protected');
    expect(safetyOf({ ...base, host: '10.0.0.5', source: 'docker' })).toBe('dev');
    expect(safetyOf({ ...base, kind: 'mongodb', host: 'cluster0.x.mongodb.net', srv: true })).toBe('protected');
    expect(safetyOf({ ...base, host: '127.0.0.1', safety: 'readonly' })).toBe('readonly');
  });
});
