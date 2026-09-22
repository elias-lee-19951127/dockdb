import { describe, expect, it } from 'vitest';
import { ColumnInfo, TableRef } from '../src/model';
import { DIALECTS } from '../src/sql/dialect';
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
  });
});
