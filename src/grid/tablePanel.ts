import * as vscode from 'vscode';
import { TableAccess } from '../drivers';
import { explainError } from '../drivers/errors';
import { ConnectionConfig, GridColumn, TableRef } from '../model';
import { log } from '../log';
import { SAFETY, safetyOf } from '../safety';
import { ConnectionManager } from '../store/connectionManager';
import { gridHtml } from './html';
import { FromWebview, Sort, ToWebview } from './protocol';

export interface OpenQueryRequest {
  connId: string;
  database: string;
  sql: string;
}

/** One panel per table / collection: paging, filtering, sorting, editing/adding/deleting rows. */
export class TablePanel {
  private static readonly open = new Map<string, TablePanel>();

  static show(
    ctx: vscode.ExtensionContext,
    manager: ConnectionManager,
    config: ConnectionConfig,
    table: TableRef,
    openQuery: (req: OpenQueryRequest) => void,
    /** Open with rows where `column` = `value` (following a foreign key). */
    equals?: { column: string; value: string },
  ): void {
    const key = `${config.id}|${table.database}|${table.schema ?? ''}|${table.name}`;
    const existing = TablePanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      if (equals && existing.access) existing.post({ type: 'apply-filter', where: existing.access.equalsFilter(equals.column, equals.value) });
      return;
    }
    const panel = vscode.window.createWebviewPanel('dockdb.table', table.name, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    });
    panel.iconPath = new vscode.ThemeIcon(table.type === 'view' ? 'eye' : 'table');
    const tp = new TablePanel(panel, ctx, manager, config, table, openQuery, equals);
    TablePanel.open.set(key, tp);
    panel.onDidDispose(() => TablePanel.open.delete(key));
  }

  /** Re-initializes open grids of a connection, e.g. after its safety mode changed. */
  static reloadConnection(config: ConnectionConfig): void {
    for (const tp of TablePanel.open.values()) {
      if (tp.config.id !== config.id) continue;
      tp.config = config;
      void tp.init().catch((e) => tp.post({ type: 'error', ...explainError(e) }));
    }
  }

  private access: TableAccess | undefined;
  private columns: GridColumn[] = [];
  private loadSeq = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private config: ConnectionConfig,
    private readonly table: TableRef,
    private readonly openQuery: (req: OpenQueryRequest) => void,
    private readonly equals?: { column: string; value: string },
  ) {
    panel.webview.html = gridHtml(panel.webview, ctx.extensionUri);
    panel.webview.onDidReceiveMessage((m: FromWebview) => {
      log(`table:recv:${m.type}`, m.type === 'client-error' ? `error ${m.message}` : table.name);
      this.handle(m).catch((e) => this.post({ type: 'error', ...explainError(e) }));
    });
  }

  private post(m: ToWebview) {
    log(`table:send:${m.type}`, m.type === 'error' ? m.message : m.type === 'page' ? `${this.table.name} rows=${m.rows.length}` : this.table.name);
    void this.panel.webview.postMessage(m);
  }

  private get pageSize(): number {
    return vscode.workspace.getConfiguration('dockdb').get('pageSize', 200);
  }

  private async handle(m: FromWebview): Promise<void> {
    if (m.type === 'ready') return this.init();
    const access = this.access;
    if (!access) return;
    switch (m.type) {
      case 'load':
        return this.load(access, m.offset, m.where, m.search, m.sort);
      case 'preview': {
        const p = access.preview(m.edits);
        return this.post({ type: 'sql-preview', title: p.title, sql: p.text });
      }
      case 'save':
        if (safetyOf(this.config) === 'readonly') throw new Error(`"${this.config.name}" is read-only — nothing was saved.`);
        return this.post({ type: 'saved', affected: await access.save(m.edits) });
      case 'change-safety':
        await vscode.commands.executeCommand('dockdb.setSafety', this.config.id);
        return;
      case 'open-query':
        return this.openQuery({ connId: this.config.id, database: this.table.database, sql: access.editorQuery(m.where, this.pageSize) });
      case 'info':
        void vscode.window.showInformationMessage(m.message);
        return;
      case 'open-ref': {
        const ref = this.columns.find((c) => c.name === m.column)?.references;
        if (ref) TablePanel.show(this.ctx, this.manager, this.config, ref.table, this.openQuery, { column: ref.column, value: m.value });
        return;
      }
    }
  }

  private async init() {
    const driver = await this.manager.get(this.config.id);
    const access = driver.openTable(this.table);
    const meta = await access.meta();
    const safety = safetyOf(this.config);
    if (safety === 'readonly' && meta.editable) {
      meta.editable = false;
      meta.readOnlyReason = `The connection "${this.config.name}" is ${SAFETY.readonly.label}. ${SAFETY.readonly.description}`;
    }
    this.access = access;
    this.columns = meta.columns;
    const where = [this.table.schema, this.table.database !== this.table.schema ? this.table.database : undefined, this.config.name]
      .filter((x) => x && x !== 'main')
      .join(' · ');
    this.post({
      type: 'table-init',
      title: this.table.name,
      subtitle: where,
      pageSize: this.pageSize,
      kind: driver.kind,
      safety,
      initialFilter: this.equals ? access.equalsFilter(this.equals.column, this.equals.value) : undefined,
      ...meta,
    });
  }

  private async load(access: TableAccess, offset: number, filter: string, search: string, sort: Sort | null) {
    const seq = ++this.loadSeq;
    const page = await access.page(filter, search, sort, this.pageSize, offset);
    if (seq !== this.loadSeq) return;
    this.post({ type: 'page', offset, ...page });
    // Count the total afterwards so the page shows up immediately.
    access
      .count(filter, search)
      .then((total) => seq === this.loadSeq && this.post({ type: 'total', total }))
      .catch(() => seq === this.loadSeq && this.post({ type: 'total', total: null }));
  }
}
