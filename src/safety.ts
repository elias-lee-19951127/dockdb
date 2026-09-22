import { ConnectionConfig } from './model';
import { parseShell } from './mongo/shell';

/**
 * How careful DockDB is with a connection. Named by protection level rather than by
 * environment: a shared "dev" database may deserve Protected, a local copy of prod may be Dev.
 */
export type Safety = 'dev' | 'protected' | 'readonly';

export const SAFETY: Record<Safety, { label: string; short: string; icon: string; color: string; description: string }> = {
  dev: {
    label: 'Dev',
    short: 'dev',
    icon: 'pass',
    color: 'charts.green',
    description: 'Edit freely. Only deleting rows asks for confirmation.',
  },
  protected: {
    label: 'Protected',
    short: 'protected',
    icon: 'shield',
    color: 'charts.orange',
    description: 'Every save and every write query shows what will run and asks for confirmation.',
  },
  readonly: {
    label: 'Read-only',
    short: 'read-only',
    icon: 'lock',
    color: 'charts.red',
    description: 'No edits and no write queries. Postgres/MySQL sessions are also read-only on the server.',
  },
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

/** Explicit choice, or a default: local/Docker/SQLite → Dev, anything remote → Protected. */
export function safetyOf(config: ConnectionConfig): Safety {
  if (config.safety) return config.safety;
  if (config.kind === 'sqlite' || config.source === 'docker') return 'dev';
  const host = (config.host ?? 'localhost').toLowerCase();
  return !config.srv && LOCAL_HOSTS.has(host) ? 'dev' : 'protected';
}

// ───────────── does a statement write? ─────────────

/** Blanks out comments and string/identifier literals so keywords inside them are ignored. */
function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
}

const READ_START = /^(select|show|explain|describe|desc|values|table|with|use|set|begin|start\s+transaction|commit|rollback|pragma)\b/;
/** Data-changing clauses that can hide inside SELECT/WITH (CTEs) or EXPLAIN ANALYZE. */
const EMBEDDED_WRITE = /\b(insert\s+into|update\s+[\w."`]+\s+set|delete\s+from|merge\s+into|truncate|drop\s+(table|schema|database|index|view)|alter\s+table|create\s+(table|index|schema|database|view))\b/;

/** True if a SQL statement may change data or schema. Errs on the side of "write". */
export function isWriteSql(sql: string): boolean {
  const s = stripSql(sql).trim().replace(/^\(+\s*/, '').toLowerCase();
  if (!s) return false;
  if (!READ_START.test(s)) return true;
  const first = s.split(/\s+/)[0];
  if (first === 'set') return /read[_\s]*only|read\s+write/.test(s); // switching read-only off
  if (first === 'pragma') return s.includes('='); // PRAGMA x = y writes
  if (first === 'explain') return /\banalyze\b/.test(s) && EMBEDDED_WRITE.test(s); // EXPLAIN ANALYZE executes the statement
  if (first === 'select' || first === 'with' || first === 'values' || first === 'table') {
    if (/\binto\b/.test(s)) return true; // SELECT … INTO new_table / OUTFILE
    return EMBEDDED_WRITE.test(s);
  }
  return false;
}

const READ_METHODS = new Set([
  'find',
  'findOne',
  'aggregate',
  'count',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'getIndexes',
  'indexes',
  'listIndexes',
  'stats',
  'getCollectionNames',
  'getCollectionInfos',
  'version',
  'getName',
]);
const READ_COMMANDS = new Set([
  'ping',
  'hello',
  'ismaster',
  'buildinfo',
  'serverstatus',
  'dbstats',
  'collstats',
  'listcollections',
  'listdatabases',
  'listindexes',
  'count',
  'distinct',
  'find',
  'explain',
  'connectionstatus',
  'hostinfo',
  'getparameter',
  'currentop',
]);

/** True if a mongo shell command may change data. Unparsable input is not: it fails with a syntax error before reaching the server. */
export function isWriteMongo(text: string): boolean {
  let cmd;
  try {
    cmd = parseShell(text);
  } catch {
    return false; // it will fail to run anyway, with a syntax error
  }
  if (cmd.kind === 'show' || cmd.kind === 'use') return false;
  const [first, ...rest] = cmd.calls;
  if (!READ_METHODS.has(first.name) && first.name !== 'runCommand' && first.name !== 'adminCommand') return true;
  if (first.name === 'runCommand' || first.name === 'adminCommand') {
    const name = Object.keys((first.args[0] as object) ?? {})[0]?.toLowerCase();
    return !name || !READ_COMMANDS.has(name);
  }
  if (first.name === 'aggregate') {
    const stages = Array.isArray(first.args[0]) ? (first.args[0] as object[]) : [];
    if (stages.some((st) => st && ('$out' in st || '$merge' in st))) return true;
  }
  return rest.some((c) => !['sort', 'limit', 'skip', 'project', 'projection', 'hint', 'collation', 'maxTimeMS', 'batchSize', 'comment', 'allowDiskUse', 'count', 'countDocuments', 'explain', 'toArray', 'pretty'].includes(c.name));
}
