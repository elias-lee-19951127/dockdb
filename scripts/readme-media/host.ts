// Stands in for the extension side of the webviews when capturing the README screenshots:
// the grid talks to the real SQLite driver, the import panel to the real paste parser.
import { parsePastedText } from '../../src/discovery/pasteParser';
import { SqliteDriver } from '../../src/drivers/sqlite';
import { explainError } from '../../src/drivers/errors';
import type { FromWebview, ResultItem, ToWebview } from '../../src/grid/protocol';
import { KIND_LABEL, TableRef } from '../../src/model';
import { Safety } from '../../src/safety';
import { summarizePlan, tablesIn } from '../../src/timeline/analyze';
import type { TimelineQuery } from '../../src/timeline/protocol';

export function gridHost(file: string, wasmDir: string, tableName: string, safety: Safety, post: (m: ToWebview) => void) {
  const driver = new SqliteDriver({ id: 'demo', name: 'shop.db', kind: 'sqlite', file, source: 'file', safety }, wasmDir);
  const table: TableRef = { database: 'main', name: tableName, type: 'table' };
  const access = driver.openTable(table);
  return async (m: FromWebview): Promise<void> => {
    try {
      switch (m.type) {
        case 'ready': {
          const meta = await access.meta();
          if (safety === 'readonly') {
            meta.editable = false;
            meta.readOnlyReason = 'The connection "shop.db" is Read-only. Grid editing is disabled and write queries are refused.';
          }
          return post({ type: 'table-init', title: tableName, subtitle: 'shop.db', pageSize: 200, kind: 'sqlite', safety, ...meta });
        }
        case 'load': {
          const page = await access.page(m.where, m.search, m.sort, 200, m.offset);
          post({ type: 'page', offset: m.offset, ...page });
          return post({ type: 'total', total: await access.count(m.where, m.search) });
        }
        case 'preview': {
          const p = access.preview(m.edits);
          return post({ type: 'sql-preview', title: p.title, sql: p.text });
        }
        case 'save':
          return post({ type: 'saved', affected: await access.save(m.edits) });
        case 'client-error':
          console.error('webview:', m.message);
          return;
      }
    } catch (e) {
      post({ type: 'error', ...explainError(e) });
    }
  };
}

/** Runs statements the way the query editor does, one result tab per statement. */
export async function runQueries(file: string, wasmDir: string, sqls: string[]): Promise<ResultItem[]> {
  const driver = new SqliteDriver({ id: 'demo', name: 'shop.db', kind: 'sqlite', file, source: 'file' }, wasmDir);
  const items: ResultItem[] = [];
  for (const [i, sql] of sqls.entries()) {
    const r = await driver.query('main', sql, [], 1000);
    items.push({ title: `${sqls.length > 1 ? `#${i + 1} ` : ''}${sql.split(/\s+/).slice(0, 3).join(' ')}`, sql, columns: r.columns, rows: r.rows, affectedRows: r.affectedRows, durationMs: r.durationMs, truncated: r.truncated });
  }
  return items;
}

export function importPreview(text: string) {
  return parsePastedText(text).map((d) => ({
    name: d.name,
    kind: KIND_LABEL[d.kind],
    target: d.kind === 'sqlite' ? d.file ?? '' : `${d.host}:${d.port}`,
    user: d.user,
    database: d.database,
    hasPassword: d.password !== undefined,
    note: d.note,
  }));
}

/** What a small web shop's backend sends while a user opens their order history — including an N+1. */
export function timelineQueries(now: number): TimelineQuery[] {
  const out: TimelineQuery[] = [];
  let id = 1;
  const q = (at: number, durationMs: number, sql: string, params: (string | null)[] = []) =>
    out.push({ id: id++, at: now + at, app: 'shop-api', database: 'shop', durationMs, sql, params, tables: tablesIn(sql) });
  // action 1: sign in
  q(0, 0.42, 'SELECT "u"."id", "u"."email", "u"."password_hash", "u"."name" FROM "users" AS "u" WHERE "u"."email" = $1 LIMIT 1', ['ana@example.com']);
  q(6, 1.8, 'UPDATE "users" SET "last_login_at" = $1 WHERE "id" = $2', ['2026-10-27 09:14:03', '7']);
  // action 2: order history page
  const t = 2400;
  q(t, 48.6, 'SELECT "o"."id", "o"."total", "o"."status", "o"."created_at" FROM "orders" AS "o" WHERE "o"."user_id" = $1 ORDER BY "o"."created_at" DESC LIMIT 20', ['7']);
  const products = ['12', '4', '31', '8', '19', '4'];
  products.forEach((p, i) => q(t + 52 + i * 3, 0.3 + (i % 3) * 0.05, 'SELECT "p"."id", "p"."name", "p"."price" FROM "products" AS "p" WHERE "p"."id" = $1', [p]));
  q(t + 80, 2.1, 'SELECT count(*) AS "count" FROM "reviews" AS "r" WHERE "r"."user_id" = $1', ['7']);
  return out;
}

/** EXPLAIN (ANALYZE, FORMAT JSON) of the slow orders query on a table without an index on user_id. */
const ordersPlan = [
  {
    Plan: {
      'Node Type': 'Limit',
      'Actual Total Time': 48.1,
      'Actual Rows': 20,
      'Actual Loops': 1,
      Plans: [
        {
          'Node Type': 'Sort',
          'Actual Total Time': 48.0,
          'Actual Rows': 20,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'orders',
              Filter: '(user_id = 7)',
              'Actual Total Time': 46.9,
              'Actual Rows': 23,
              'Actual Loops': 1,
              'Rows Removed by Filter': 249977,
            },
          ],
        },
      ],
    },
    'Execution Time': 48.3,
  },
];

export const ordersSummary = summarizePlan(ordersPlan);
