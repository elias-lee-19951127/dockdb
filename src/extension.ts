import * as vscode from 'vscode';
import { discoverAll } from './discovery';
import { explainError } from './drivers/errors';
import { trace } from './log';
import { ResultsView } from './grid/resultsView';
import { TablePanel } from './grid/tablePanel';
import { ImportPanel } from './import/importPanel';
import { ConnectionConfig, DEFAULT_PORT, DetectedDb } from './model';
import { Safety, SAFETY, safetyOf } from './safety';
import { QueryRunner } from './query/queryRunner';
import { SqlDriver } from './drivers';
import { askCredentials, ConnectionManager } from './store/connectionManager';
import { ConnectionStore } from './store/connectionStore';
import { connIdOf, Explorer, Node } from './tree/explorer';

let manager: ConnectionManager | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  const store = new ConnectionStore(ctx);
  manager = new ConnectionManager(store, vscode.Uri.joinPath(ctx.extensionUri, 'dist').fsPath);
  const mgr = manager;
  const explorer = new Explorer(store, mgr);
  const treeView = vscode.window.createTreeView('dockdb.explorer', {
    treeDataProvider: { ...bind(explorer), getParent: () => undefined },
    showCollapseAll: true,
  });
  const results = new ResultsView(ctx.extensionUri);
  const runner = new QueryRunner(ctx, store, mgr, results);

  // ── tree message: scan problems and the active table search ──
  let scanNote: string | undefined;
  let searchNote: string | undefined;
  const showMessage = () => (treeView.message = [searchNote, scanNote].filter(Boolean).join('\n') || undefined);
  explorer.onDidFilter(({ filter, matches }) => {
    searchNote = `🔍 ${matches} table${matches === 1 ? '' : 's'} matching “${filter}” in connected databases — ✕ in the title bar shows all`;
    showMessage();
  });
  const setSearch = (text: string) => {
    explorer.setFilter(text);
    if (!explorer.filterText) searchNote = undefined;
    showMessage();
    void vscode.commands.executeCommand('setContext', 'dockdb.searching', !!explorer.filterText);
  };
  const searchTables = () => {
    const box = vscode.window.createInputBox();
    box.title = 'Search tables';
    box.placeholder = 'Type part of a table or collection name';
    box.prompt = 'Filters the Databases panel as you type. Enter or Esc keeps the result; clear the text to show everything.';
    box.value = explorer.filterText;
    let timer: NodeJS.Timeout | undefined;
    box.onDidChangeValue((v) => {
      clearTimeout(timer);
      timer = setTimeout(() => setSearch(v), 150);
    });
    box.onDidAccept(() => box.hide());
    box.onDidHide(() => {
      clearTimeout(timer);
      setSearch(box.value);
      box.dispose();
    });
    box.show();
  };

  // ── auto discovery ──
  let discovering: Promise<void> | undefined;
  const discover = (silent: boolean) =>
    (discovering ??= Promise.resolve(
      vscode.window.withProgress({ location: { viewId: 'dockdb.explorer' }, title: 'Scanning Docker & ports…' }, async () => {
        const r = await discoverAll();
        await store.setDetected(r.databases);
        scanNote = r.dockerError ? `${r.dockerError} — only ports and SQLite files were scanned.` : undefined;
        showMessage();
        if (!silent) {
          const n = r.databases.length;
          void vscode.window.setStatusBarMessage(`DockDB: found ${n} database${n === 1 ? '' : 's'}`, 3000);
        }
      }),
    )
      .then(
        () => undefined,
        (e) => void vscode.window.showErrorMessage(`DockDB: scan failed — ${(e as Error).message}`),
      )
      .finally(() => (discovering = undefined)));

  let discoveredOnce = false;
  const autoDiscover = () => {
    if (discoveredOnce || !vscode.workspace.getConfiguration('dockdb').get('autoDiscover', true)) return;
    discoveredOnce = true;
    void discover(true);
  };
  if (treeView.visible) autoDiscover();
  treeView.onDidChangeVisibility((e) => e.visible && autoDiscover());

  const openQuery = (req: { connId: string; database: string; sql: string }) => runner.newQuery(req.connId, req.database, req.sql);

  const onImported = (dbs: DetectedDb[]) => {
    if (!dbs.length) return;
    void vscode.commands.executeCommand('dockdb.explorer.focus');
    const first = store.get(dbs[0].id);
    if (first) void treeView.reveal({ type: 'connection', config: first }, { expand: true, select: true });
    void vscode.window.showInformationMessage(`Added ${dbs.map((d) => d.name).join(', ')}`);
  };

  const pickConnId = async (node?: Node): Promise<string | undefined> => {
    const id = connIdOf(node);
    if (id) return id;
    const pick = await vscode.window.showQuickPick(
      store.all().map((c) => ({ label: c.name, description: c.kind, id: c.id })),
      { title: 'Pick a connection' },
    );
    return pick?.id;
  };

  const connectionOf = (node?: Node): ConnectionConfig | undefined => {
    const id = connIdOf(node);
    return id ? store.get(id) : undefined;
  };

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        void vscode.window.showErrorMessage(`DockDB: ${(e as Error).message}`);
      }
    });

  ctx.subscriptions.push(
    treeView,
    vscode.window.registerWebviewViewProvider(ResultsView.id, results, { webviewOptions: { retainContextWhenHidden: true } }),

    cmd('dockdb.discover', () => discover(false)),
    cmd('dockdb.import', () => ImportPanel.show(ctx, store, onImported)),
    cmd('dockdb.addConnection', () => addConnection(ctx, store, onImported)),
    cmd('dockdb.refreshTree', () => explorer.refresh()),
    cmd('dockdb.searchTables', searchTables),
    cmd('dockdb.clearSearch', () => setSearch('')),
    cmd('dockdb.refreshNode', () => explorer.refresh()),

    cmd('dockdb.openTable', (node?: Node) => {
      if (node?.type !== 'table') return;
      const config = store.get(node.connId);
      if (config) TablePanel.show(ctx, mgr, config, node.table, openQuery);
    }),

    cmd('dockdb.newQuery', async (node?: Node) => {
      const connId = await pickConnId(node);
      if (!connId) return;
      const driver = await mgr.get(connId);
      if (node?.type === 'table') return runner.newQuery(connId, node.table.database, driver.sampleQuery(node.table));
      const database = node?.type === 'database' || node?.type === 'schema' ? node.database : undefined;
      let text = '';
      if (node?.type === 'schema' && driver.kind === 'postgres') text = `SET search_path TO ${(driver as SqlDriver).dialect.quoteIdent(node.schema)};\n`;
      if (driver.queryLanguage === 'mongo') text = '// ⌘/Ctrl+Enter runs the command under the cursor\ndb.getCollectionNames()\n';
      return runner.newQuery(connId, database, text);
    }),
    cmd('dockdb.runQuery', () => runner.runFromEditor()),
    cmd('dockdb.runStatement', (uri: vscode.Uri, start: number, end: number) => runner.runRange(uri, start, end)),
    cmd('dockdb.pickConnection', (doc?: vscode.TextDocument) => runner.pickConnection(doc)),

    cmd('dockdb.saveConnection', async (node?: Node) => {
      const c = connectionOf(node);
      if (c) await store.save(c, await store.getPassword(c.id));
    }),
    cmd('dockdb.editCredentials', async (node?: Node) => {
      const c = connectionOf(node);
      if (!c || c.kind === 'sqlite') return;
      const creds = await askCredentials(c);
      if (!creds) return;
      const database = await vscode.window.showInputBox({
        title: `Default database for ${c.name}`,
        prompt: 'Leave empty to use the server default',
        value: c.database ?? '',
      });
      if (database === undefined) return;
      await mgr.disconnect(c.id);
      await store.update(c.id, { user: creds.user, database: database || undefined }, creds.password);
    }),
    cmd('dockdb.setSafety', async (target?: Node | string) => {
      const c = typeof target === 'string' ? store.get(target) : connectionOf(target) ?? store.get((await pickConnId()) ?? '');
      if (!c) return;
      const current = safetyOf(c);
      const order: Safety[] = ['dev', 'protected', 'readonly'];
      const pick = await vscode.window.showQuickPick(
        order.map((s) => ({
          label: `$(${SAFETY[s].icon}) ${SAFETY[s].label}${s === current ? '  (current)' : ''}`,
          detail: SAFETY[s].description,
          safety: s,
        })),
        { title: `Safety mode for "${c.name}"`, placeHolder: 'How careful should DockDB be with this connection?' },
      );
      if (!pick || pick.safety === current) return;
      await mgr.disconnect(c.id); // Postgres/MySQL sessions are opened read-only or not
      const updated = await store.update(c.id, { safety: pick.safety });
      if (updated) TablePanel.reloadConnection(updated);
      void vscode.window.setStatusBarMessage(`DockDB: "${c.name}" is now ${SAFETY[pick.safety].label}`, 3000);
    }),
    cmd('dockdb.renameConnection', async (node?: Node) => {
      const c = connectionOf(node);
      if (!c) return;
      const name = await vscode.window.showInputBox({ title: 'Rename connection', value: c.name });
      if (name) await store.update(c.id, { name });
    }),
    cmd('dockdb.removeConnection', async (node?: Node) => {
      const c = connectionOf(node);
      if (!c) return;
      const ok = await vscode.window.showWarningMessage(`Remove connection "${c.name}"? (The database itself is not touched.)`, { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      await mgr.disconnect(c.id);
      await store.remove(c.id);
    }),
    cmd('dockdb.disconnect', async (node?: Node) => {
      const id = connIdOf(node);
      if (!id) return;
      await mgr.disconnect(id);
      explorer.refresh();
    }),
    cmd('dockdb.copyUrl', async (node?: Node) => {
      const c = connectionOf(node);
      if (!c) return;
      const user = c.user ? `${encodeURIComponent(c.user)}@` : '';
      const url =
        c.kind === 'sqlite'
          ? `sqlite://${c.file}`
          : c.kind === 'mongodb'
            ? `mongodb${c.srv ? '+srv' : ''}://${user}${c.srv ? c.host : `${c.host}:${c.port}`}/${c.database ?? ''}${c.user ? `?authSource=${c.authSource ?? 'admin'}` : ''}`
            : c.kind === 'mssql'
              ? `sqlserver://${user}${c.host}:${c.port}/${c.database ?? ''}`
              : `${c.kind === 'postgres' ? 'postgresql' : 'mysql'}://${user}${c.host}:${c.port}/${c.database ?? ''}`;
      await vscode.env.clipboard.writeText(url);
      void vscode.window.setStatusBarMessage('Copied URL (without password)', 2500);
    }),
    cmd('dockdb.copyName', async (node?: Node) => {
      if (node?.type !== 'table') return;
      const driver = await mgr.get(node.connId);
      await vscode.env.clipboard.writeText(driver.qualifiedName(node.table));
    }),
  );

  // Used by the integration tests (test/e2e).
  return { store, explorer, manager: mgr, runner, trace, explainError };
}

/** TreeView needs an object with methods — keep `this` bound when extracting them. */
function bind(explorer: Explorer): vscode.TreeDataProvider<Node> {
  return {
    onDidChangeTreeData: explorer.onDidChangeTreeData,
    getTreeItem: (n) => explorer.getTreeItem(n),
    getChildren: (n) => explorer.getChildren(n),
  };
}

async function addConnection(ctx: vscode.ExtensionContext, store: ConnectionStore, onImported: (dbs: DetectedDb[]) => void) {
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(clippy) Paste a URL / docker inspect / compose…', id: 'paste' },
      { label: '$(database) PostgreSQL', id: 'postgres' },
      { label: '$(database) MySQL / MariaDB', id: 'mysql' },
      { label: '$(database) Microsoft SQL Server', id: 'mssql' },
      { label: '$(database) MongoDB', id: 'mongodb' },
      { label: '$(file) File SQLite…', id: 'sqlite' },
    ],
    { title: 'Add connection' },
  );
  if (!choice) return;
  if (choice.id === 'paste') return ImportPanel.show(ctx, store, onImported);

  if (choice.id === 'sqlite') {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] } });
    if (!files?.[0]) return;
    const file = files[0].fsPath;
    const db: DetectedDb = { id: `file:${file}`, name: file.split(/[\\/]/).pop() ?? file, kind: 'sqlite', file, source: 'manual' };
    await store.save(db);
    return onImported([db]);
  }

  const kind = choice.id as 'postgres' | 'mysql' | 'mssql' | 'mongodb';
  const address = await vscode.window.showInputBox({
    title: `${choice.label.replace(/\$\(\w+\) /, '')} — address`,
    prompt: 'host:port',
    value: `localhost:${DEFAULT_PORT[kind]}`,
    validateInput: (v) => (/^[^\s:]+(:\d{1,5})?$/.test(v.trim()) ? undefined : 'Use host:port, e.g. localhost:5432'),
  });
  if (!address) return;
  const [host, portText] = address.trim().split(':');
  const port = portText ? Number(portText) : DEFAULT_PORT[kind];
  const creds = await askCredentials({ id: '', name: `${host}:${port}`, kind, host, port, source: 'manual' });
  if (!creds) return;
  const database = await vscode.window.showInputBox({ title: 'Database (optional)', prompt: 'Leave empty to browse all databases' });
  if (database === undefined) return;
  const db: DetectedDb = {
    id: `manual:${kind}:${host}:${port}:${Date.now()}`,
    name: `${host}:${port}`,
    kind,
    host,
    port,
    user: creds.user || undefined,
    database: database || undefined,
    source: 'manual',
  };
  await store.save(db, creds.password);
  onImported([db]);
}

export async function deactivate(): Promise<void> {
  await manager?.disposeAll();
}
