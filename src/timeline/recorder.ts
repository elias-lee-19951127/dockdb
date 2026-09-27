import { ChildProcess, spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { PostgresDriver } from '../drivers/postgres';
import { log } from '../log';
import { ConnectionConfig } from '../model';
import { safetyOf } from '../safety';
import { ConnectionManager } from '../store/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { tablesIn, TimelineQuery } from './analyze';
import { LOG_PREFIX, LoggedQuery, PgLogParser } from './pgLog';

/** Server settings changed while recording, and what to put back. */
const SETTINGS: Record<string, string> = { log_min_duration_statement: '0', log_line_prefix: LOG_PREFIX };
const PENDING_KEY = 'dockdb.timeline.pendingRestore';
const MAX_QUERIES = 1000;

/** Saved before touching the server so a crash can be undone on the next start. `value: null` = RESET. */
interface PendingRestore {
  connId: string;
  name: string;
  restore: { name: string; value: string | null }[];
}

export interface RecorderState {
  recording?: { connId: string; name: string; since: number };
  error?: string;
}

/**
 * Records the queries apps run against a Postgres container: turns on statement logging with
 * ALTER SYSTEM + pg_reload_conf() (no restart), follows `docker logs`, and puts the settings back.
 */
export class QueryRecorder implements vscode.Disposable {
  private proc: ChildProcess | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private current: RecorderState['recording'];
  private nextId = 1;
  private stopping: Promise<void> | undefined;
  readonly queries: TimelineQuery[] = [];

  private readonly queriesEmitter = new vscode.EventEmitter<TimelineQuery[]>();
  readonly onQueries = this.queriesEmitter.event;
  private readonly stateEmitter = new vscode.EventEmitter<RecorderState>();
  readonly onState = this.stateEmitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {}

  get state(): RecorderState {
    return { recording: this.current };
  }

  /** Connections the timeline can record: Postgres running in Docker, in Dev mode. */
  candidates(): ConnectionConfig[] {
    return this.store.all().filter((c) => whyNot(c) === undefined);
  }

  get(id: number): TimelineQuery | undefined {
    return this.queries.find((q) => q.id === id);
  }

  clear(): void {
    this.queries.length = 0;
  }

  async start(connId: string, opts: { confirmed?: boolean } = {}): Promise<boolean> {
    const config = this.store.get(connId);
    if (!config) throw new Error('This connection no longer exists');
    const reason = whyNot(config);
    if (reason) throw new Error(reason);
    if (this.current) await this.stop();

    if (!opts.confirmed) {
      const ok = await vscode.window.showWarningMessage(
        `Record the queries apps run on "${config.name}"?`,
        {
          modal: true,
          detail:
            'DockDB will turn on statement logging in this container without restarting it:\n\n' +
            `ALTER SYSTEM SET log_min_duration_statement = 0;\nALTER SYSTEM SET log_line_prefix = '${LOG_PREFIX}';\nSELECT pg_reload_conf();\n\n` +
            'Your previous settings are put back when you stop recording, disconnect or close VS Code.',
        },
        'Start recording',
      );
      if (ok !== 'Start recording') return false;
    }

    const driver = await this.pgDriver(connId);
    const db = driver.defaultDatabase;
    const current = await driver.query(
      db,
      `SELECT name, setting, sourcefile LIKE '%postgresql.auto.conf' FROM pg_settings WHERE name = ANY($1)`,
      [`{${Object.keys(SETTINGS).join(',')}}`],
    );
    const pending: PendingRestore = {
      connId,
      name: config.name,
      restore: current.rows.map((r) => ({ name: r[0]!, value: r[2] === 't' || r[2] === 'true' ? r[1] : null })),
    };
    await this.ctx.globalState.update(PENDING_KEY, pending);
    try {
      for (const [name, value] of Object.entries(SETTINGS)) await driver.query(db, `ALTER SYSTEM SET ${name} = ${literal(value)}`);
      await driver.query(db, 'SELECT pg_reload_conf()');
    } catch (e) {
      await this.restore(pending).catch(() => undefined);
      const msg = (e as Error).message;
      throw new Error(
        /permission denied|must be superuser/i.test(msg)
          ? `"${config.user ?? 'this user'}" may not change server settings (ALTER SYSTEM needs a superuser). Run the statements shown when starting as a superuser, or connect as one.`
          : msg,
      );
    }

    this.current = { connId, name: config.name, since: Date.now() };
    this.follow(config.containerName!);
    log('timeline:start', config.name);
    this.stateEmitter.fire(this.state);
    return true;
  }

  async stop(error?: string): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.current) return;
    this.stopping = (async () => {
      this.unfollow();
      const pending = this.ctx.globalState.get<PendingRestore>(PENDING_KEY);
      try {
        if (pending) await this.restore(pending);
        log('timeline:stop', this.current?.name);
      } catch (e) {
        error ??= `Could not put the logging settings back: ${(e as Error).message}. DockDB will offer to retry next time.`;
      } finally {
        this.current = undefined;
        this.stateEmitter.fire({ ...this.state, error });
        this.stopping = undefined;
      }
    })();
    return this.stopping;
  }

  /** On activation: a recording that was never stopped (crash, killed window) still has logging on. */
  async recover(): Promise<void> {
    const pending = this.ctx.globalState.get<PendingRestore>(PENDING_KEY);
    if (!pending) return;
    if (!this.store.get(pending.connId)) {
      await this.ctx.globalState.update(PENDING_KEY, undefined);
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `DockDB was recording queries on "${pending.name}" and did not switch statement logging off. Put the previous settings back now?`,
      'Restore settings',
      'Leave as is',
    );
    if (pick === 'Leave as is') await this.ctx.globalState.update(PENDING_KEY, undefined);
    if (pick !== 'Restore settings') return;
    try {
      await this.restore(pending);
      void vscode.window.showInformationMessage(`Statement logging on "${pending.name}" is back to its previous settings.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`DockDB: could not restore settings on "${pending.name}": ${(e as Error).message}`);
    }
  }

  dispose(): void {
    this.unfollow();
  }

  /** EXPLAIN of a recorded query, on the database it ran against. */
  async explain(id: number, analyze: boolean): Promise<unknown> {
    const q = this.get(id);
    if (!q || !this.lastConnId) throw new Error('This query is no longer in the timeline');
    const driver = await this.pgDriver(this.lastConnId);
    return driver.explain(q.database || driver.defaultDatabase, q.sql, q.params, analyze);
  }

  /** Connection the listed queries came from (kept after stopping so they can still be explained). */
  lastConnId: string | undefined;

  private async restore(p: PendingRestore): Promise<void> {
    const driver = await this.pgDriver(p.connId);
    const db = driver.defaultDatabase;
    for (const name of Object.keys(SETTINGS)) {
      const prev = p.restore.find((r) => r.name === name);
      await driver.query(db, prev?.value != null ? `ALTER SYSTEM SET ${name} = ${literal(prev.value)}` : `ALTER SYSTEM RESET ${name}`);
    }
    await driver.query(db, 'SELECT pg_reload_conf()');
    await this.ctx.globalState.update(PENDING_KEY, undefined);
  }

  private async pgDriver(connId: string): Promise<PostgresDriver> {
    const driver = await this.manager.get(connId);
    if (!(driver instanceof PostgresDriver)) throw new Error('The query timeline supports Postgres only for now');
    return driver;
  }

  private follow(container: string): void {
    const docker = vscode.workspace.getConfiguration('dockdb').get('dockerPath', 'docker');
    const since = new Date(Date.now() - 1000).toISOString();
    const parser = new PgLogParser();
    this.lastConnId = this.current!.connId;
    const proc = spawn(docker, ['logs', '--follow', '--since', since, container], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let lastLine = Date.now();
    const emit = (logged: LoggedQuery[]) => {
      if (!logged.length) return;
      const added = logged.map((l) => ({ id: this.nextId++, at: l.at, app: l.app, database: l.database, durationMs: l.durationMs, sql: l.sql, params: l.params, tables: tablesIn(l.sql) }));
      this.queries.push(...added);
      if (this.queries.length > MAX_QUERIES) this.queries.splice(0, this.queries.length - MAX_QUERIES);
      log('timeline:queries', String(added.length));
      this.queriesEmitter.fire(added);
    };
    // Postgres in Docker logs to stderr; read both, line by line.
    for (const stream of [proc.stdout!, proc.stderr!]) {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop()!;
        lastLine = Date.now();
        emit(lines.flatMap((l) => parser.feed(l.replace(/\r$/, ''))));
      });
    }
    // The last query waits for a possible DETAIL line; let it go once the log is quiet.
    this.flushTimer = setInterval(() => Date.now() - lastLine > 150 && emit(parser.flush()), 250);
    proc.on('error', (e) => void this.stop(`Could not read the container logs: ${e.message}`));
    proc.on('exit', (code) => {
      if (this.proc === proc) void this.stop(code ? `The container log stream ended (exit ${code}) — is "${container}" still running?` : undefined);
    });
  }

  private unfollow(): void {
    clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    const proc = this.proc;
    this.proc = undefined;
    proc?.kill();
  }
}

/** Why the timeline cannot record this connection, or undefined when it can. */
export function whyNot(c: ConnectionConfig): string | undefined {
  if (c.kind !== 'postgres') return 'The query timeline supports Postgres only for now';
  if (!c.containerName) return `"${c.name}" does not run in a Docker container DockDB found — the timeline reads the container's logs`;
  if (safetyOf(c) !== 'dev') return `"${c.name}" is not in Dev mode. Recording changes server logging settings, so it is only allowed on Dev connections`;
  return undefined;
}

const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;
