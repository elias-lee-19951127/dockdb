import * as vscode from 'vscode';
import { AuthError, createDriver, Driver } from '../drivers';
import { ConnectionConfig } from '../model';
import { ConnectionStore } from './connectionStore';

export class CancelledError extends Error {}

/** Keeps an open driver per connection; asks for user/password when login fails. */
export class ConnectionManager {
  private readonly drivers = new Map<string, Promise<Driver>>();
  readonly versions = new Map<string, string>();

  constructor(private readonly store: ConnectionStore, private readonly wasmDir: string) {}

  isConnected(id: string): boolean {
    return this.drivers.has(id);
  }

  get(id: string): Promise<Driver> {
    let p = this.drivers.get(id);
    if (!p) {
      p = this.connect(id);
      this.drivers.set(id, p);
      p.catch(() => this.drivers.delete(id));
    }
    return p;
  }

  private async connect(id: string): Promise<Driver> {
    let config = this.store.get(id);
    if (!config) throw new Error('This connection no longer exists');
    let password = await this.store.getPassword(id);

    for (let attempt = 0; ; attempt++) {
      const driver = createDriver(config, password, this.wasmDir);
      try {
        const version = await driver.ping();
        if (version) this.versions.set(id, version);
        // First successful connect → save it so it does not need rediscovering.
        if (!this.store.isSaved(id)) await this.store.save(config, password);
        return driver;
      } catch (e) {
        await driver.close();
        if (!(e instanceof AuthError) || attempt >= 3) throw friendly(e, config);
        const creds = await askCredentials(config, attempt === 0 && password === undefined ? undefined : e.message);
        if (!creds) throw new CancelledError();
        password = creds.password;
        config = (await this.store.update(id, { user: creds.user || undefined }, creds.password)) ?? config;
      }
    }
  }

  async disconnect(id: string): Promise<void> {
    const p = this.drivers.get(id);
    this.drivers.delete(id);
    this.versions.delete(id);
    if (p) await (await p.catch(() => undefined))?.close();
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.drivers.keys()].map((id) => this.disconnect(id)));
  }
}

export async function askCredentials(config: ConnectionConfig, reason?: string): Promise<{ user: string; password: string } | undefined> {
  const target = `${config.name} (${config.host}:${config.port})`;
  const mongo = config.kind === 'mongodb';
  const user = await vscode.window.showInputBox({
    title: `Sign in to ${target}`,
    prompt: `${reason ? `${reason} — enter the user again` : 'User'}${mongo ? ' (leave empty if MongoDB has no authentication)' : ''}`,
    value: config.user ?? (config.kind === 'postgres' ? 'postgres' : config.kind === 'mssql' ? 'sa' : mongo ? '' : 'root'),
    ignoreFocusOut: true,
  });
  if (user === undefined) return undefined;
  if (mongo && !user) return { user: '', password: '' };
  const password = await vscode.window.showInputBox({
    title: `Sign in to ${target}`,
    prompt: `Password for "${user}" (stored securely in the VS Code keychain)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) return undefined;
  return { user, password };
}

function friendly(e: unknown, config: ConnectionConfig): Error {
  const err = e as { code?: string; number?: number; message?: string };
  const where = config.kind === 'sqlite' ? config.file : `${config.host}:${config.port}`;
  if (err.code === 'ECONNREFUSED' || (err.code === 'ESOCKET' && /ECONNREFUSED/.test(err.message ?? ''))) {
    return new Error(`Cannot connect to ${where} — the database is not running or the port is not published.`);
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ETIMEOUT' || /timeout/i.test(err.message ?? '')) return new Error(`Timed out connecting to ${where}.`);
  if (err.code === 'ENOENT') return new Error(`File not found: ${where}.`);
  if (err.code === '3D000' || err.code === 'ER_BAD_DB_ERROR' || err.number === 4060 || /Cannot open database ".*" requested by the login/i.test(err.message ?? '')) {
    return new Error(`${err.message}. Change the default database via "Edit credentials".`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
