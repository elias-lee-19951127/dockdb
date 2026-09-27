// Turns Postgres server log lines into the queries an app ran.
// The recorder sets log_line_prefix to LOG_PREFIX so every line says which app and database it came from.

/** Prefix the recorder sets while recording: time, backend pid, application_name, database. */
export const LOG_PREFIX = '%m [%p] app=%a db=%d ';

export interface LoggedQuery {
  /** Epoch ms when the statement finished (from the log timestamp). */
  at: number;
  pid: number;
  app: string;
  database: string;
  /** parse + bind + execute time for extended-protocol queries. */
  durationMs: number;
  sql: string;
  /** Bound values as the server logged them (`$1` is params[0]); null for SQL NULL. */
  params: (string | null)[];
}

const LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?) ?(\S*) \[(\d+)\] app=(.*?) db=(.*?) (LOG|DETAIL|STATEMENT|ERROR|WARNING|FATAL|HINT|CONTEXT|NOTICE):  (.*)$/;
const DURATION = /^duration: ([\d.]+) ms {2}(statement|parse|bind|execute) ?([^:]*): ([\s\S]*)$/;

/** Statements every ORM sends that say nothing about the app's data access. */
const NOISE = /^\s*(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|DEALLOCATE|DISCARD|SET|RESET|SHOW|LISTEN|UNLISTEN)\b/i;

interface Pending {
  query: LoggedQuery;
  /** Continuation lines of a multi-line statement still belong to it. */
  open: boolean;
}

/**
 * Feed it lines as they arrive; it returns finished queries. A query is finished when the next line
 * from anywhere arrives (its DETAIL with parameters, if any, comes right after it) or on flush().
 */
export class PgLogParser {
  private pending: Pending | undefined;
  /** parse/bind time per backend, added to the execute that follows. */
  private readonly prep = new Map<number, number>();

  constructor(private readonly ignoreApps: string[] = ['DockDB']) {}

  feed(line: string): LoggedQuery[] {
    const out: LoggedQuery[] = [];
    if (line.startsWith('\t') && this.pending?.open) {
      this.pending.query.sql += '\n' + line.slice(1);
      return out;
    }
    const m = LINE.exec(line);
    if (!m) return out;
    const [, time, zone, pidText, app, database, level, message] = m;
    const pid = Number(pidText);

    if (level === 'DETAIL' && this.pending && this.pending.query.pid === pid) {
      const params = /^parameters: ([\s\S]*)$/.exec(message);
      if (params) this.pending.query.params = parseParams(params[1]);
      this.pending.open = false;
      return out;
    }
    this.flushInto(out);
    if (level !== 'LOG') return out;

    const d = DURATION.exec(message);
    if (!d) return out;
    const [, ms, phase, , sql] = d;
    if (phase === 'parse' || phase === 'bind') {
      this.prep.set(pid, (this.prep.get(pid) ?? 0) + Number(ms));
      return out;
    }
    const durationMs = Number(ms) + (this.prep.get(pid) ?? 0);
    this.prep.delete(pid);
    if (this.ignoreApps.includes(app) || NOISE.test(sql)) return out;
    this.pending = {
      query: { at: parseTime(time, zone), pid, app, database, durationMs: round(durationMs), sql, params: [] },
      open: true,
    };
    return out;
  }

  /** Emits the query still waiting for a possible DETAIL line. */
  flush(): LoggedQuery[] {
    const out: LoggedQuery[] = [];
    this.flushInto(out);
    return out;
  }

  private flushInto(out: LoggedQuery[]) {
    if (this.pending) out.push(this.pending.query);
    this.pending = undefined;
  }
}

/** `$1 = '90', $2 = 'it''s', $3 = NULL` → ['90', "it's", null] */
export function parseParams(text: string): (string | null)[] {
  const out: (string | null)[] = [];
  const re = /\$(\d+) = (?:'((?:[^']|'')*)'|NULL)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out[Number(m[1]) - 1] = m[2] === undefined ? null : m[2].replace(/''/g, "'");
  return Array.from(out, (v) => (v === undefined ? null : v));
}

function parseTime(time: string, zone: string): number {
  const iso = time.replace(' ', 'T');
  const t = Date.parse(zone === 'UTC' || zone === 'GMT' ? iso + 'Z' : iso);
  return Number.isNaN(t) ? Date.now() : t;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
