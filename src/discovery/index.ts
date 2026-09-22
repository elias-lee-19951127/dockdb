import fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { DetectedDb } from '../model';
import { sameTarget } from '../store/connectionStore';
import { scanDocker } from './docker';
import { scanPorts } from './portScan';

export interface DiscoveryResult {
  databases: DetectedDb[];
  dockerError?: string;
}

/** Scans Docker, local ports and workspace SQLite files in parallel, then merges and de-duplicates. */
export async function discoverAll(): Promise<DiscoveryResult> {
  const cfg = vscode.workspace.getConfiguration('dockdb');
  const [docker, ports, sqlite] = await Promise.all([
    scanDocker(cfg.get('dockerPath', 'docker')),
    scanPorts(cfg.get<number[]>('extraPorts', [])),
    findSqliteFiles(),
  ]);

  const out: DetectedDb[] = [...docker.databases];
  for (const p of ports) {
    const candidate: DetectedDb = {
      id: `scan:${p.kind}:${p.port}`,
      name: `localhost:${p.port}`,
      kind: p.kind,
      host: '127.0.0.1',
      port: p.port,
      // Mongo: try without credentials first; DockDB asks if the server requires auth.
      user: p.kind === 'postgres' ? 'postgres' : p.kind === 'mongodb' ? undefined : 'root',
      source: 'scan',
      image: p.version,
    };
    // Container ports already have credentials from docker inspect → drop the scanned duplicate.
    if (!out.some((d) => sameTarget(d, candidate))) out.push(candidate);
  }
  out.push(...sqlite);
  return { databases: out, dockerError: docker.error };
}

const SQLITE_HEADER = 'SQLite format 3\0';

export async function findSqliteFiles(): Promise<DetectedDb[]> {
  if (!vscode.workspace.workspaceFolders?.length) return [];
  const uris = await vscode.workspace.findFiles('**/*.{sqlite,sqlite3,db,db3}', '**/{node_modules,.git,dist,build}/**', 30);
  const out: DetectedDb[] = [];
  for (const uri of uris) {
    try {
      const fh = await fs.open(uri.fsPath, 'r');
      const head = Buffer.alloc(16);
      await fh.read(head, 0, 16, 0).finally(() => fh.close());
      if (head.toString('latin1') !== SQLITE_HEADER) continue;
      out.push({
        id: `file:${uri.fsPath}`,
        name: vscode.workspace.asRelativePath(uri),
        kind: 'sqlite',
        file: uri.fsPath,
        source: 'file',
      });
    } catch {
      // skip unreadable files
    }
  }
  return out;
}
