// Pure helpers behind the Query Timeline: grouping, N+1 detection, table extraction, EXPLAIN summaries.
// Bundled into both the extension and the timeline webview.

export interface TimelineQuery {
  id: number;
  at: number;
  app: string;
  database: string;
  durationMs: number;
  sql: string;
  params: (string | null)[];
  tables: string[];
}

export interface Cluster {
  start: number;
  end: number;
  totalMs: number;
  queries: TimelineQuery[];
  /** id of the slowest query, when the cluster has more than one. */
  slowest?: number;
  /** fingerprint → how many times it ran in this cluster (only the ones at N1_MIN or more). */
  repeated: Map<string, number>;
}

/** Queries this close together are treated as one user action. */
export const CLUSTER_GAP_MS = 300;
/** The same query this many times in one action looks like an N+1. */
export const N1_MIN = 5;

/** Tables a statement reads or writes, without schema or quotes: `"public"."items"` → `items`. */
export function tablesIn(sql: string): string[] {
  const noStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  const ident = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
  const re = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?(${ident}(?:\s*\.\s*${ident})*)`, 'gi');
  const out: string[] = [];
  for (let m = re.exec(noStrings); m; m = re.exec(noStrings)) {
    const parts = m[1].split(/\s*\.\s*/);
    const name = parts[parts.length - 1].replace(/^"|"$/g, '').replace(/""/g, '"');
    if (/^(select|lateral|unnest|generate_series)$/i.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Same statement shape regardless of literal values and whitespace. */
export function fingerprint(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Splits a time-ordered list into user actions and flags the slowest query and repeated ones in each. */
export function cluster(queries: TimelineQuery[], gapMs = CLUSTER_GAP_MS): Cluster[] {
  const out: Cluster[] = [];
  let cur: Cluster | undefined;
  for (const q of queries) {
    if (!cur || q.at - cur.end > gapMs) {
      cur = { start: q.at, end: q.at, totalMs: 0, queries: [], repeated: new Map() };
      out.push(cur);
    }
    cur.queries.push(q);
    cur.end = q.at;
    cur.totalMs += q.durationMs;
  }
  for (const c of out) {
    c.totalMs = Math.round(c.totalMs * 1000) / 1000;
    if (c.queries.length > 1) c.slowest = c.queries.reduce((a, b) => (b.durationMs > a.durationMs ? b : a)).id;
    const counts = new Map<string, number>();
    for (const q of c.queries) counts.set(fingerprint(q.sql), (counts.get(fingerprint(q.sql)) ?? 0) + 1);
    for (const [fp, n] of counts) if (n >= N1_MIN) c.repeated.set(fp, n);
  }
  return out;
}

/**
 * One-line, human-scale version of ORM SQL for lists: drops quotes around plain names and
 * `schema.` / `table.` qualifiers, and folds a long column list. Display only — never run it.
 */
export function readableSql(sql: string, foldColumns = true): string {
  let s = sql.replace(/\s+/g, ' ').trim();
  const strings: string[] = [];
  s = s.replace(/'(?:[^']|'')*'/g, (m) => `\u0000${strings.push(m) - 1}\u0000`);
  s = s.replace(/"([a-z_][a-z0-9_]*)"/g, '$1'); // "items" → items
  s = s.replace(/\b[a-z_][a-z0-9_]*\.(?=[a-z_*"])/gi, ''); // public.items.id → id
  s = s.replace(/^SELECT (DISTINCT )?(.+?) FROM /i, (whole, distinct: string | undefined, cols: string) => {
    if (!foldColumns || cols.length <= 40) return whole;
    const n = cols.split(',').length;
    return `SELECT ${distinct ?? ''}${cols.split(',').slice(0, 2).map((c) => c.trim()).join(', ')}, … (${n} columns) FROM `;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => strings[Number(i)]);
}

/** Puts logged values back into the SQL so it can be run from an editor: `$1` → `'42'`. */
export function inlineParams(sql: string, params: (string | null)[]): string {
  if (!params.length) return sql;
  // Leave $n inside string literals and dollar-quoted bodies alone.
  return sql.replace(/('(?:[^']|'')*')|\$(\d+)\b/g, (whole, str: string | undefined, n: string | undefined) => {
    if (str !== undefined || n === undefined) return whole;
    const v = params[Number(n) - 1];
    if (v === undefined) return whole;
    return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
  });
}

// ───────────────────────── EXPLAIN (FORMAT JSON) ─────────────────────────

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Filter?: string;
  'Index Cond'?: string;
  'Hash Cond'?: string;
  'Join Filter'?: string;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

export interface PlanStep {
  depth: number;
  label: string;
  relation?: string;
  detail?: string;
  /** Rows produced (actual when analyzed, else estimated). */
  rows?: number;
  rowsRemoved?: number;
  /** Time spent in this step alone (analyzed plans only). */
  selfMs?: number;
  /** Share of the total: time when analyzed, cost otherwise. */
  pct: number;
  hot: boolean;
}

export interface PlanSummary {
  analyzed: boolean;
  totalMs?: number;
  headline: string;
  steps: PlanStep[];
  /** A CREATE INDEX worth trying, when the plan points to one. */
  suggestion?: { sql: string; why: string };
}

const HOT_PCT = 40;

/** Reads EXPLAIN (FORMAT JSON) output and says, in plain words, where the time goes. */
export function summarizePlan(explain: unknown): PlanSummary {
  const root = (Array.isArray(explain) ? explain[0] : explain) as { Plan: PlanNode; 'Execution Time'?: number };
  const analyzed = root.Plan['Actual Total Time'] !== undefined;
  const weight = (n: PlanNode) => (analyzed ? (n['Actual Total Time'] ?? 0) * (n['Actual Loops'] ?? 1) : n['Total Cost'] ?? 0);
  const self = (n: PlanNode) => Math.max(0, weight(n) - (n.Plans ?? []).reduce((s, c) => s + weight(c), 0));
  const total = analyzed ? root['Execution Time'] ?? weight(root.Plan) : weight(root.Plan);

  const flat: { n: PlanNode; depth: number }[] = [];
  const walk = (n: PlanNode, depth: number) => {
    flat.push({ n, depth });
    (n.Plans ?? []).forEach((c) => walk(c, depth + 1));
  };
  walk(root.Plan, 0);

  const steps: PlanStep[] = flat.map(({ n, depth }) => {
    const pct = total > 0 ? Math.round((self(n) / total) * 100) : 0;
    return {
      depth,
      label: n['Node Type'],
      relation: n['Relation Name'],
      detail: n['Index Cond'] ?? n.Filter ?? n['Hash Cond'] ?? n['Join Filter'],
      rows: analyzed ? (n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1) : n['Plan Rows'],
      rowsRemoved: n['Rows Removed by Filter'] !== undefined ? n['Rows Removed by Filter'] * (n['Actual Loops'] ?? 1) : undefined,
      selfMs: analyzed ? Math.round(self(n) * 1000) / 1000 : undefined,
      pct,
      hot: pct >= HOT_PCT,
    };
  });

  const worst = flat.reduce((a, b) => (self(b.n) > self(a.n) ? b : a));
  const w = worst.n;
  const share = total > 0 ? Math.round((self(w) / total) * 100) : 0;
  const scanned = analyzed ? (w['Actual Rows'] ?? 0) * (w['Actual Loops'] ?? 1) + (w['Rows Removed by Filter'] ?? 0) * (w['Actual Loops'] ?? 1) : w['Plan Rows'];
  let headline: string;
  if (w['Node Type'] === 'Seq Scan' && w['Relation Name']) {
    headline = `Reads every row of ${w['Relation Name']}${scanned !== undefined ? ` (${fmt(scanned)} rows)` : ''}${w.Filter ? ` to find the ones matching ${tidy(w.Filter)}` : ''} — ${share}% of the ${analyzed ? 'time' : 'estimated cost'}.`;
  } else if (w['Relation Name']) {
    headline = `Most ${analyzed ? 'time' : 'cost'} (${share}%) goes to ${w['Node Type']} on ${w['Relation Name']}.`;
  } else {
    headline = `Most ${analyzed ? 'time' : 'cost'} (${share}%) goes to the ${w['Node Type']} step.`;
  }

  return { analyzed, totalMs: analyzed ? Math.round(total * 1000) / 1000 : undefined, headline, steps, suggestion: suggestIndex(flat.map((f) => f.n), total, self, analyzed) };
}

function suggestIndex(nodes: PlanNode[], total: number, self: (n: PlanNode) => number, analyzed: boolean): PlanSummary['suggestion'] {
  const scans = nodes
    .filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] && n.Filter)
    .sort((a, b) => self(b) - self(a));
  for (const n of scans) {
    // Only when the scan throws most rows away — then an index lets it jump to the few it keeps.
    const kept = analyzed ? n['Actual Rows'] ?? 0 : n['Plan Rows'] ?? 0;
    const removed = n['Rows Removed by Filter'];
    if (analyzed && removed !== undefined && removed < kept * 4) continue;
    if (total > 0 && self(n) / total < 0.2) continue;
    const col = /\(?\(?"?([A-Za-z_][\w$]*)"?\)?(?:::\w+)?\s*(?:=|<|>|<=|>=|~~|~~\*|IS)\s/.exec(n.Filter!)?.[1];
    if (!col) continue;
    const table = n['Relation Name']!;
    const q = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    return {
      sql: `CREATE INDEX ON ${q(table)} (${q(col)});`,
      why: `${table} is read in full to filter on ${col}${removed !== undefined ? `, discarding ${fmt(removed)} rows` : ''}. An index on ${col} lets Postgres go straight to the matching rows.`,
    };
  }
  return undefined;
}

const tidy = (cond: string) => cond.replace(/^\((.*)\)$/, '$1').replace(/::\w+(\[\])?/g, '');
const fmt = (n: number) => n.toLocaleString('en-US');
