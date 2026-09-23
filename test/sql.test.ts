import { describe, expect, it } from 'vitest';
import { ColumnInfo, TableRef } from '../src/model';
import { DIALECTS } from '../src/sql/dialect';
import { mongoFilterExample, sqlFilterExample } from '../src/sql/filterExample';
import { buildStatements, chooseKeySpec, renderForPreview } from '../src/sql/mutations';
import { splitStatements, statementAt } from '../src/sql/splitStatements';

const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType: 'text',
  nullable: true,
  isPrimaryKey: false,
  hasDefault: false,
  isAutoIncrement: false,
  ...extra,
});

describe('splitStatements', () => {
  it('ignores ; inside strings, comments and dollar quotes', () => {
    const sql = `select ';' as a; -- comment ;
/* block ; */ insert into t values ('it''s; ok');
create function f() returns int as $$ begin return 1; end $$ language plpgsql;
select \`a;b\` from x`;
    const parts = splitStatements(sql).map((s) => s.text);
    expect(parts).toHaveLength(4);
    expect(parts[1]).toBe("insert into t values ('it''s; ok')");
    expect(parts[2]).toContain('return 1; end $$');
  });

  it('statementAt picks the statement under the cursor or the one before', () => {
    const sql = 'select 1;\n\nselect 2;\n\n';
    const st = splitStatements(sql);
    expect(statementAt(st, 2)?.text).toBe('select 1');
    expect(statementAt(st, sql.length)?.text).toBe('select 2');
  });

  it('drops comment-only statements', () => {
    expect(splitStatements('-- only a comment\n;  ;')).toEqual([]);
  });
});

describe('buildStatements', () => {
  const pgTable: TableRef = { database: 'app', schema: 'public', name: 'users', type: 'table' };
  const cols = [col('id', { isPrimaryKey: true, isAutoIncrement: true, hasDefault: true }), col('email'), col('name')];

  it('postgres: update by PK, insert only filled columns, delete', () => {
    const spec = chooseKeySpec(DIALECTS.postgres, pgTable, cols)!;
    const out = buildStatements(DIALECTS.postgres, pgTable, spec, [
      { type: 'delete', key: ['3'] },
      { type: 'update', key: ['1'], set: { email: 'a@b.c', name: null } },
      { type: 'insert', values: { email: 'x@y.z' } },
      { type: 'insert', values: {} },
    ]);
    expect(out.map((s) => s.sql)).toEqual([
      'DELETE FROM "public"."users" WHERE "id" = $1',
      'UPDATE "public"."users" SET "email" = $1, "name" = $2 WHERE "id" = $3',
      'INSERT INTO "public"."users" ("email") VALUES ($1)',
      'INSERT INTO "public"."users" DEFAULT VALUES',
    ]);
    expect(out[1].params).toEqual(['a@b.c', null, '1']);
    expect(out[1].expectOneRow).toBe(true);
  });

  it('postgres without a PK → uses ctid', () => {
    const spec = chooseKeySpec(DIALECTS.postgres, pgTable, [col('a')])!;
    const [st] = buildStatements(DIALECTS.postgres, pgTable, spec, [{ type: 'update', key: ['(0,1)'], set: { a: 'z' } }]);
    expect(st.sql).toBe('UPDATE "public"."users" SET "a" = $1 WHERE ctid = $2::tid');
  });

  it('mysql without a PK → matches every column (NULL-safe) + LIMIT 1', () => {
    const t: TableRef = { database: 'shop', name: 'logs', type: 'table' };
    const spec = chooseKeySpec(DIALECTS.mysql, t, [col('a'), col('b')])!;
    const [st] = buildStatements(DIALECTS.mysql, t, spec, [{ type: 'delete', key: ['1', null] }]);
    expect(st.sql).toBe('DELETE FROM `shop`.`logs` WHERE `a` <=> ? AND `b` <=> ? LIMIT 1');
    expect(renderForPreview(st)).toBe("DELETE FROM `shop`.`logs` WHERE `a` <=> '1' AND `b` <=> NULL LIMIT 1;");
  });

  it('views are not editable', () => {
    expect(chooseKeySpec(DIALECTS.mysql, { database: 'x', name: 'v', type: 'view' }, [col('a')])).toBeUndefined();
  });

  it('quotes identifiers with special characters', () => {
    expect(DIALECTS.postgres.quoteIdent('we"ird')).toBe('"we""ird"');
    expect(DIALECTS.mysql.quoteIdent('we`ird')).toBe('`we``ird`');
    expect(DIALECTS.mssql.quoteIdent('we]ird')).toBe('[we]]ird]');
  });

  it('mssql: qualifies with the dbo schema by default, quotes with brackets', () => {
    const t: TableRef = { database: 'shop', name: 'users', type: 'table' };
    expect(DIALECTS.mssql.qualified(t)).toBe('[dbo].[users]');
    expect(DIALECTS.mssql.qualified({ ...t, schema: 'sales' })).toBe('[sales].[users]');
  });

  it('mssql without a PK → matches every column + TOP (1)', () => {
    const t: TableRef = { database: 'shop', schema: 'dbo', name: 'logs', type: 'table' };
    const spec = chooseKeySpec(DIALECTS.mssql, t, [col('a'), col('b')])!;
    const [del] = buildStatements(DIALECTS.mssql, t, spec, [{ type: 'delete', key: ['1', null] }]);
    expect(del.sql).toBe('DELETE TOP (1) FROM [dbo].[logs] WHERE (([a] = @p1) OR ([a] IS NULL AND @p1 IS NULL)) AND (([b] = @p2) OR ([b] IS NULL AND @p2 IS NULL))');
    expect(renderForPreview(del)).toBe(
      "DELETE TOP (1) FROM [dbo].[logs] WHERE (([a] = '1') OR ([a] IS NULL AND '1' IS NULL)) AND (([b] = NULL) OR ([b] IS NULL AND NULL IS NULL));",
    );
    const [upd] = buildStatements(DIALECTS.mssql, t, spec, [{ type: 'update', key: ['1', '2'], set: { a: 'z' } }]);
    expect(upd.sql).toBe('UPDATE TOP (1) [dbo].[logs] SET [a] = @p1 WHERE (([a] = @p2) OR ([a] IS NULL AND @p2 IS NULL)) AND (([b] = @p3) OR ([b] IS NULL AND @p3 IS NULL))');
  });

  it('mssql: OFFSET/FETCH paging synthesizes an ORDER BY when none is given', () => {
    expect(DIALECTS.mssql.paginate('SELECT * FROM [t]', false, 50, 100)).toBe('SELECT * FROM [t] ORDER BY (SELECT NULL) OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
    expect(DIALECTS.mssql.paginate('SELECT * FROM [t] ORDER BY [id] ASC', true, 50, 100)).toBe('SELECT * FROM [t] ORDER BY [id] ASC OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
  });
});

describe('filter placeholder', () => {
  it('uses a numeric and a text column of the table', () => {
    expect(sqlFilterExample([col('id', { dataType: 'int' }), col('active', { dataType: 'tinyint(1)' }), col('email', { dataType: 'varchar(120)' })], '`')).toBe(
      "e.g. id > 10 AND email LIKE '%a%'  (Enter to apply)",
    );
  });
  it('quotes names that need it, per dialect', () => {
    expect(sqlFilterExample([col('Unit Price', { dataType: 'numeric(10,2)' })], '"')).toBe('e.g. "Unit Price" > 10  (Enter to apply)');
    expect(sqlFilterExample([col('Unit Price', { dataType: 'money' })], '[')).toBe('e.g. [Unit Price] > 10  (Enter to apply)');
  });
  it('falls back to a generic example', () => {
    expect(sqlFilterExample([col('data', { dataType: 'bytea' })], '"')).toContain('email LIKE');
  });
  it('builds a MongoDB filter from the collection fields', () => {
    expect(mongoFilterExample([{ name: '_id', dataType: 'objectId' }, { name: 'qty', dataType: 'int' }, { name: 'sku', dataType: 'string' }])).toBe(
      'e.g. { qty: { $gt: 18 }, sku: /an/i }  (Enter to apply)',
    );
    expect(mongoFilterExample([{ name: '_id', dataType: 'objectId' }])).toContain('age');
  });
});
