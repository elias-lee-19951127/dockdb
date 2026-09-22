import * as vscode from 'vscode';
import { ConnectionConfig, DetectedDb } from '../model';

const STATE_KEY = 'dockdb.connections';
const secretKey = (id: string) => `dockdb.password.${id}`;

/** Single home for connections: saved (globalState + SecretStorage) and detected (in memory). */
export class ConnectionStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private detected: DetectedDb[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  saved(): ConnectionConfig[] {
    return this.ctx.globalState.get<ConnectionConfig[]>(STATE_KEY, []);
  }

  isSaved(id: string): boolean {
    return this.saved().some((c) => c.id === id);
  }

  /** Saved connections first, then detected databases that are not saved yet. */
  all(): ConnectionConfig[] {
    const saved = this.saved();
    const fresh = this.detected.filter((d) => !saved.some((s) => sameTarget(s, d)));
    return [...saved, ...fresh];
  }

  get(id: string): ConnectionConfig | undefined {
    return this.all().find((c) => c.id === id);
  }

  async getPassword(id: string): Promise<string | undefined> {
    return (await this.ctx.secrets.get(secretKey(id))) ?? this.detected.find((d) => d.id === id)?.password;
  }

  /** Replaces the detected list; saved docker connections follow their container if its port changed. */
  async setDetected(list: DetectedDb[]): Promise<void> {
    this.detected = list;
    const saved = this.saved();
    let dirty = false;
    for (const s of saved) {
      const match = list.find((d) => d.containerName && d.containerName === s.containerName && d.kind === s.kind);
      if (match && (match.host !== s.host || match.port !== s.port)) {
        s.host = match.host;
        s.port = match.port;
        dirty = true;
      }
    }
    if (dirty) await this.ctx.globalState.update(STATE_KEY, saved);
    this.changed.fire();
  }

  addDetected(list: DetectedDb[]): void {
    const ids = new Set(list.map((d) => d.id));
    this.detected = [...list, ...this.detected.filter((d) => !ids.has(d.id))];
    this.changed.fire();
  }

  async save(config: ConnectionConfig, password?: string): Promise<void> {
    const { password: detectedPw, ...clean } = config as DetectedDb;
    const saved = this.saved().filter((c) => c.id !== clean.id);
    saved.push(clean);
    await this.ctx.globalState.update(STATE_KEY, saved);
    const pw = password ?? detectedPw ?? this.detected.find((d) => d.id === clean.id)?.password;
    if (pw !== undefined) await this.ctx.secrets.store(secretKey(clean.id), pw);
    this.changed.fire();
  }

  async update(id: string, patch: Partial<ConnectionConfig>, password?: string): Promise<ConnectionConfig | undefined> {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    if (this.isSaved(id)) {
      await this.ctx.globalState.update(STATE_KEY, this.saved().map((c) => (c.id === id ? next : c)));
      if (password !== undefined) await this.ctx.secrets.store(secretKey(id), password);
      this.changed.fire();
    } else {
      await this.save(next, password);
    }
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(STATE_KEY, this.saved().filter((c) => c.id !== id));
    await this.ctx.secrets.delete(secretKey(id));
    this.changed.fire();
  }
}

export function sameTarget(a: ConnectionConfig, b: ConnectionConfig): boolean {
  if (a.id === b.id) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'sqlite') return a.file === b.file;
  if (a.containerName && a.containerName === b.containerName) return true;
  return isLocal(a.host) === isLocal(b.host) && (isLocal(a.host) || a.host === b.host) && a.port === b.port;
}

function isLocal(host?: string): boolean {
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
