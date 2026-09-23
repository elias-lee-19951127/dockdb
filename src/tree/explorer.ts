import * as vscode from 'vscode';
import { DriverTableInfo } from '../drivers';
import { ConnectionConfig, DbKind } from '../model';
import { SAFETY, safetyOf } from '../safety';
import { CancelledError, ConnectionManager } from '../store/connectionManager';
import { ConnectionStore } from '../store/connectionStore';

export type Node =
  | { type: 'connection'; config: ConnectionConfig }
  | { type: 'database'; connId: string; database: string }
  | { type: 'schema'; connId: string; database: string; schema: string }
  | { type: 'table'; connId: string; table: DriverTableInfo }
  | { type: 'info'; id: string; label: string; icon: string; command?: vscode.Command; tooltip?: string };

const KIND_SHORT: Record<DbKind, string> = { postgres: 'Postgres', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB', mssql: 'SQL Server' };
const KIND_COLOR: Record<DbKind, string> = { postgres: 'charts.blue', mysql: 'charts.orange', sqlite: 'charts.purple', mongodb: 'charts.green', mssql: 'charts.red' };
const SOURCE_LABEL = { docker: 'docker', scan: 'port', file: 'file', manual: '', url: '' } as const;

export class Explorer implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: ConnectionStore, private readonly manager: ConnectionManager) {
    store.onDidChange(() => this.refresh());
  }

  refresh(node?: Node): void {
    this.changed.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'connection':
        return this.connectionItem(node.config);
      case 'database': {
        const item = new vscode.TreeItem(node.database || '(default)', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${node.connId}/${node.database}`;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'database';
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${node.connId}/${node.database}/${node.schema}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return item;
      }
      case 'table': {
        const t = node.table;
        const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
        item.id = `${node.connId}/${t.database}/${t.schema ?? ''}/${t.name}`;
        item.iconPath = new vscode.ThemeIcon(t.type === 'view' ? 'eye' : 'table');
        item.description = t.estimatedRows !== undefined && t.estimatedRows > 0 ? `~${compact(t.estimatedRows)}` : t.type === 'view' ? 'view' : undefined;
        item.tooltip = `${t.schema ? t.schema + '.' : ''}${t.name}${t.type === 'view' ? ' (view)' : ''}`;
        item.contextValue = 'table';
        item.command = { command: 'dockdb.openTable', title: 'Open table', arguments: [node] };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.command = node.command;
        item.tooltip = node.tooltip ?? node.label;
        return item;
      }
    }
  }

  private connectionItem(c: ConnectionConfig): vscode.TreeItem {
    const saved = this.store.isSaved(c.id);
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = c.id;
    item.iconPath = new vscode.ThemeIcon(this.manager.isConnected(c.id) ? 'database' : 'circle-large-outline', new vscode.ThemeColor(KIND_COLOR[c.kind]));
    const version = this.manager.versions.get(c.id)?.split(/[\s-]/)[0] ?? c.image;
    const parts = [KIND_SHORT[c.kind] + (version && c.kind !== 'sqlite' ? ` ${version}` : ''), SOURCE_LABEL[c.source], c.note];
    const safety = safetyOf(c);
    if (safety !== 'dev') parts.unshift(safety === 'readonly' ? '🔒 read-only' : '🛡 protected');
    if (!saved) parts.push('new');
    item.description = parts.filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${c.name}** — ${KIND_SHORT[c.kind]}\n\n`);
    if (c.kind === 'sqlite') md.appendMarkdown(`File: \`${c.file}\`\n\n`);
    else md.appendMarkdown(`\`${c.user ?? '?'}@${c.host}:${c.port}${c.database ? '/' + c.database : ''}\`\n\n`);
    if (c.containerName) md.appendMarkdown(`Container: \`${c.containerName}\`${c.image ? ` (${c.image})` : ''}\n\n`);
    if (c.note) md.appendMarkdown(`⚠️ ${c.note}\n\n`);
    md.appendMarkdown(`Safety: **${SAFETY[safety].label}**${c.safety ? '' : ' (automatic)'} — ${SAFETY[safety].description}\n\n`);
    if (!saved) md.appendMarkdown('_Auto-detected — saved automatically when you open it._');
    item.tooltip = md;
    item.contextValue = saved ? 'connection' : 'detected';
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.store.all().map((config) => ({ type: 'connection', config }));
    const wasConnected = node.type === 'connection' && this.manager.isConnected(node.config.id);
    try {
      switch (node.type) {
        case 'connection':
          return await this.connectionChildren(node.config);
        case 'database':
          return await this.databaseChildren(node.connId, node.database);
        case 'schema':
          return await this.tables(node.connId, node.database, node.schema);
        default:
          return [];
      }
    } catch (e) {
      const parentId = node.type === 'connection' ? node.config.id : JSON.stringify(node);
      if (e instanceof CancelledError) {
        return [{ type: 'info', id: `${parentId}/login`, label: 'Not signed in — click to retry', icon: 'key', command: retry(node) }];
      }
      const msg = (e as Error).message;
      return [{ type: 'info', id: `${parentId}/error`, label: msg, tooltip: msg, icon: 'error', command: retry(node) }];
    } finally {
      // Redraw icon/version after the first connect (once only, to avoid a refresh loop).
      if (node.type === 'connection' && !wasConnected && this.manager.isConnected(node.config.id)) {
        setTimeout(() => this.changed.fire(undefined), 0);
      }
    }
  }

  private async connectionChildren(c: ConnectionConfig): Promise<Node[]> {
    const driver = await this.manager.get(c.id);
    const includeSystem = vscode.workspace.getConfiguration('dockdb').get('showSystemDatabases', false);
    const dbs = await driver.listDatabases(includeSystem);
    // Only one database → skip a tree level to save clicks.
    if (dbs.length === 1) return this.databaseChildren(c.id, dbs[0]);
    return dbs.map((database) => ({ type: 'database', connId: c.id, database }));
  }

  private async databaseChildren(connId: string, database: string): Promise<Node[]> {
    const driver = await this.manager.get(connId);
    if (!driver.hasSchemas) return this.tables(connId, database);
    const includeSystem = vscode.workspace.getConfiguration('dockdb').get('showSystemDatabases', false);
    const schemas = await driver.listSchemas(database, includeSystem);
    if (schemas.length === 1) return this.tables(connId, database, schemas[0]);
    return schemas.map((schema) => ({ type: 'schema', connId, database, schema }));
  }

  private async tables(connId: string, database: string, schema?: string): Promise<Node[]> {
    const driver = await this.manager.get(connId);
    const tables = await driver.listTables(database, schema);
    if (!tables.length) return [{ type: 'info', id: `${connId}/${database}/${schema}/empty`, label: driver.kind === 'mongodb' ? 'No collections yet' : 'No tables yet', icon: 'info' }];
    return tables.map((table) => ({ type: 'table', connId, table }));
  }
}

function retry(node: Node): vscode.Command {
  return { command: 'dockdb.refreshNode', title: 'Retry', arguments: [node] };
}

function compact(n: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function connIdOf(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'connection') return node.config.id;
  if (node.type === 'info') return undefined;
  return node.connId;
}
