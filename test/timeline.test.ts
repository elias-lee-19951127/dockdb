import { describe, expect, it } from 'vitest';
import { cluster, fingerprint, inlineParams, N1_MIN, readableSql, summarizePlan, tablesIn, TimelineQuery } from '../src/timeline/analyze';
import { parseParams, PgLogParser } from '../src/timeline/pgLog';

// Real lines from postgres:16 with log_min_duration_statement=0 and LOG_PREFIX, from node-postgres and Prisma.
const PG_LINES = [
  `2026-09-27 14:06:55.437 UTC [9406] app=pg-app db=shop LOG:  duration: 0.928 ms  parse <unnamed>: SELECT id, sku FROM items WHERE stock > $1 AND sku LIKE $2 LIMIT 3`,
  `2026-09-27 14:06:55.437 UTC [9406] app=pg-app db=shop LOG:  duration: 0.608 ms  bind <unnamed>: SELECT id, sku FROM items WHERE stock > $1 AND sku LIKE $2 LIMIT 3`,
  `2026-09-27 14:06:55.437 UTC [9406] app=pg-app db=shop DETAIL:  parameters: $1 = '90', $2 = 'SKU-1%'`,
  `2026-09-27 14:06:55.437 UTC [9406] app=pg-app db=shop LOG:  duration: 0.040 ms  execute <unnamed>: SELECT id, sku FROM items WHERE stock > $1 AND sku LIKE $2 LIMIT 3`,
  `2026-09-27 14:06:55.437 UTC [9406] app=pg-app db=shop DETAIL:  parameters: $1 = '90', $2 = 'SKU-1%'`,
  `2026-09-27 14:06:56.013 UTC [9407] app=prisma-app db=shop LOG:  duration: 0.594 ms  parse s0: SELECT "public"."items"."id" FROM "public"."items" WHERE "public"."items"."stock" > $1 LIMIT $2 OFFSET $3`,
  `2026-09-27 14:06:56.014 UTC [9407] app=prisma-app db=shop LOG:  duration: 0.063 ms  execute s0: SELECT "public"."items"."id" FROM "public"."items" WHERE "public"."items"."stock" > $1 LIMIT $2 OFFSET $3`,
  `2026-09-27 14:06:56.014 UTC [9407] app=prisma-app db=shop DETAIL:  parameters: $1 = '95', $2 = '2', $3 = '0'`,
];

const feedAll = (lines: string[], p = new PgLogParser()) => [...lines.flatMap((l) => p.feed(l)), ...p.flush()];

describe('PgLogParser', () => {
  it('reads node-postgres and Prisma queries with their parameters, once each', () => {
    const qs = feedAll(PG_LINES);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ pid: 9406, app: 'pg-app', database: 'shop', params: ['90', 'SKU-1%'] });
    expect(qs[0].durationMs).toBeCloseTo(0.928 + 0.608 + 0.04, 5); // parse + bind + execute
    expect(qs[0].at).toBe(Date.parse('2026-09-27T14:06:55.437Z'));
    expect(qs[1]).toMatchObject({ app: 'prisma-app', params: ['95', '2', '0'] });
  });

  it('keeps simple-protocol statements, multi-line SQL, and drops noise and DockDB itself', () => {
    const qs = feedAll([
      `2026-09-27 14:07:00.000 UTC [10] app=knex db=shop LOG:  duration: 1.500 ms  statement: BEGIN`,
      `2026-09-27 14:07:00.001 UTC [10] app=knex db=shop LOG:  duration: 2.000 ms  statement: SELECT *`,
      `\tFROM users`,
      `\tWHERE id = 1`,
      `2026-09-27 14:07:00.002 UTC [11] app=DockDB db=shop LOG:  duration: 0.100 ms  statement: SELECT 1`,
      `2026-09-27 14:07:00.003 UTC [10] app=knex db=shop LOG:  duration: 0.100 ms  statement: COMMIT`,
      `2026-09-27 14:07:00.004 UTC [1] app= db= LOG:  checkpoint starting: time`,
    ]);
    expect(qs.map((q) => q.sql)).toEqual(['SELECT *\nFROM users\nWHERE id = 1']);
  });

  it('parses quoted, escaped and NULL parameter values', () => {
    expect(parseParams(`$1 = 'it''s', $2 = NULL, $3 = '42'`)).toEqual(["it's", null, '42']);
  });
});

const q = (id: number, at: number, sql: string, durationMs = 1): TimelineQuery => ({ id, at, sql, durationMs, app: 'a', database: 'shop', params: [], tables: tablesIn(sql) });

describe('timeline analysis', () => {
  it('extracts tables from ORM-style SQL', () => {
    expect(tablesIn(`SELECT "public"."items"."id" FROM "public"."items" LEFT JOIN "public"."orders" AS t1 ON t1.item_id = items.id`)).toEqual(['items', 'orders']);
    expect(tablesIn(`INSERT INTO users (email) VALUES ('from x')`)).toEqual(['users']);
    expect(tablesIn(`UPDATE ONLY public.logs SET code = 1`)).toEqual(['logs']);
  });

  it('groups queries close in time and flags the slowest and repeated ones', () => {
    const loop = Array.from({ length: N1_MIN }, (_, i) => q(10 + i, 1100 + i * 5, `SELECT * FROM items WHERE id = $1`, 0.2));
    const cs = cluster([q(1, 1000, 'SELECT * FROM orders', 12), ...loop, q(2, 5000, 'SELECT 1 FROM users')]);
    expect(cs).toHaveLength(2);
    expect(cs[0].queries).toHaveLength(1 + N1_MIN);
    expect(cs[0].slowest).toBe(1);
    expect([...cs[0].repeated.values()]).toEqual([N1_MIN]);
    expect(cs[1].slowest).toBeUndefined();
  });

  it('makes ORM SQL readable for the list without touching string literals', () => {
    expect(readableSql(`SELECT "public"."order_items"."id", "public"."order_items"."qty", "public"."order_items"."price" FROM "public"."order_items" WHERE "public"."order_items"."order_id" = $1 LIMIT $2`)).toBe(
      'SELECT id, qty, price FROM order_items WHERE order_id = $1 LIMIT $2',
    );
    expect(readableSql(`SELECT "t"."id", "t"."email", "t"."name", "t"."created_at", "t"."updated_at", "t"."role" FROM "t"`)).toBe('SELECT id, email, … (6 columns) FROM t');
    expect(readableSql(`UPDATE "public"."users" SET "Name" = 'a.b "c"' WHERE users.id = 1`)).toBe(`UPDATE users SET "Name" = 'a.b "c"' WHERE id = 1`);
  });

  it('fingerprints ignore literal values and whitespace', () => {
    expect(fingerprint(`SELECT * FROM t WHERE id = 1`)).toBe(fingerprint(`select *  from t\nwhere id = 22`));
  });

  it('inlines logged parameters for the editor, leaving string literals alone', () => {
    expect(inlineParams(`SELECT '$1' AS x, a FROM t WHERE b = $1 AND c = $2 AND d = $10`, ["o'k", null])).toBe(
      `SELECT '$1' AS x, a FROM t WHERE b = 'o''k' AND c = NULL AND d = $10`,
    );
  });

  it('explains an analyzed plan in plain words and suggests an index', () => {
    const plan = [
      {
        Plan: {
          'Node Type': 'Limit',
          'Actual Total Time': 40,
          'Actual Rows': 3,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'order_items',
              Filter: '(order_id = 42)',
              'Actual Total Time': 39,
              'Actual Rows': 3,
              'Actual Loops': 1,
              'Rows Removed by Filter': 480000,
            },
          ],
        },
        'Execution Time': 40.1,
      },
    ];
    const s = summarizePlan(plan);
    expect(s.analyzed).toBe(true);
    expect(s.headline).toBe('Reads every row of order_items (480,003 rows) to find the ones matching order_id = 42 — 97% of the time.');
    expect(s.steps.map((st) => [st.label, st.hot])).toEqual([
      ['Limit', false],
      ['Seq Scan', true],
    ]);
    expect(s.suggestion?.sql).toBe('CREATE INDEX ON order_items (order_id);');
  });

  it('does not suggest an index when the scan keeps most rows', () => {
    const s = summarizePlan([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'items', Filter: '(stock > 1)', 'Actual Total Time': 1, 'Actual Rows': 290, 'Actual Loops': 1, 'Rows Removed by Filter': 10 }, 'Execution Time': 1 }]);
    expect(s.suggestion).toBeUndefined();
  });

  it('works on estimated (not analyzed) plans', () => {
    const s = summarizePlan([{ Plan: { 'Node Type': 'ModifyTable', 'Total Cost': 8.17, Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'items', 'Index Cond': '(id = $1)', 'Total Cost': 8.15, 'Plan Rows': 1 }] } }]);
    expect(s.analyzed).toBe(false);
    expect(s.headline).toContain('Index Scan on items');
  });
});
