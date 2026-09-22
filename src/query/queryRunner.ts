import * as vscode from 'vscode';
import { ResultsView } from '../grid/resultsView';
import { explainError } from '../drivers/errors';
import { ResultItem } from '../grid/protocol';
import { splitMongo } from '../mongo/split';
import { isWriteMongo, isWriteSql, SAFETY, safetyOf } from '../safety';
import { splitStatements, statementAt, StatementRange } from '../sql/splitStatements';
import { CancelledError, ConnectionManager } from '../store/connectionManager';
import { ConnectionStore } from '../store/connectionStore';

interface Binding {
  connId: string;
  database: string;
}

const BINDINGS_KEY = 'dockdb.sqlBindings';
export const MONGO_LANGUAGE = 'dockdb-mongo';
const QUERY_LANGUAGES = ['sql', MONGO_LANGUAGE];

function splitFor(text: string, mongo: boolean): StatementRange[] {
  return mongo ? splitMongo(text) : splitStatements(text);
}

/** Binds query files to a connection, runs statements (⌘Enter / CodeLens) and sends results to the ResultsView. */
export class QueryRunner implements vscode.CodeLensProvider {
  private readonly status: vscode.StatusBarItem;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly results: ResultsView,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'dockdb.pickConnection';
    ctx.subscriptions.push(
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      store.onDidChange(() => {
        this.updateStatus();
        this.lensChanged.fire();
      }),
      vscode.languages.registerCodeLensProvider(QUERY_LANGUAGES.map((language) => ({ language })), this),
    );
    this.updateStatus();
  }

  private bindings(): Record<string, Binding> {
    return this.ctx.workspaceState.get<Record<string, Binding>>(BINDINGS_KEY, {});
  }

  private binding(doc: vscode.TextDocument): Binding | undefined {
    const b = this.bindings()[doc.uri.toString()];
    return b && this.store.get(b.connId) ? b : undefined;
  }

  async bind(doc: vscode.TextDocument, b: Binding): Promise<void> {
    await this.ctx.workspaceState.update(BINDINGS_KEY, { ...this.bindings(), [doc.uri.toString()]: b });
    this.updateStatus();
    this.lensChanged.fire();
  }

  private label(b: Binding | undefined, withSafety = false): string {
    if (!b) return 'Pick a connection';
    const c = this.store.get(b.connId);
    const base = `${c?.name ?? '?'}${b.database && b.database !== 'main' ? ' / ' + b.database : ''}`;
    const safety = c ? safetyOf(c) : 'dev';
    return withSafety && safety !== 'dev' ? `${base}  $(${SAFETY[safety].icon}) ${SAFETY[safety].short}` : base;
  }

  private updateStatus() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !QUERY_LANGUAGES.includes(doc.languageId)) return this.status.hide();
    const b = this.binding(doc);
    this.status.text = `$(database) ${this.label(b, true)}`;
    this.status.tooltip = b ? 'DockDB: connection used by this file — click to change' : 'DockDB: pick the database to run this file against';
    this.status.show();
  }

  private isMongo(doc: vscode.TextDocument, b?: Binding): boolean {
    const kind = b && this.store.get(b.connId)?.kind;
    return kind ? kind === 'mongodb' : doc.languageId === MONGO_LANGUAGE;
  }

  /** Opens a new query file (SQL or mongo shell) bound to a connection/database. */
  async newQuery(connId: string, database: string | undefined, sql = ''): Promise<void> {
    const driver = await this.manager.get(connId);
    const db = database ?? driver.defaultDatabase;
    const language = driver.queryLanguage === 'mongo' ? MONGO_LANGUAGE : 'sql';
    const doc = await vscode.workspace.openTextDocument({ language, content: sql ? `${sql}${sql.endsWith('\n') ? '' : '\n'}` : '' });
    await this.bind(doc, { connId, database: db });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const end = doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;
    editor.selection = new vscode.Selection(end, end);
  }

  /** Asks for the connection + database of the current query file. */
  async pickConnection(doc = vscode.window.activeTextEditor?.document): Promise<Binding | undefined> {
    if (!doc) return undefined;
    // Mongo files only list MongoDB connections, SQL files the others.
    const wantMongo = doc.languageId === MONGO_LANGUAGE;
    const all = this.store.all();
    const matching = all.filter((c) => (c.kind === 'mongodb') === wantMongo);
    const conns = matching.length ? matching : all;
    if (!conns.length) {
      void vscode.window.showWarningMessage('No connections yet. Open the DockDB sidebar to scan for databases or add one.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      conns.map((c) => ({ label: `$(database) ${c.name}`, description: c.kind === 'sqlite' ? c.file : `${c.kind} · ${c.host}:${c.port}`, id: c.id })),
      { title: 'Run this file against which connection?' },
    );
    if (!pick) return undefined;
    const driver = await this.manager.get(pick.id);
    const includeSystem = vscode.workspace.getConfiguration('dockdb').get('showSystemDatabases', false);
    const dbs = await driver.listDatabases(includeSystem);
    let database = driver.defaultDatabase;
    if (dbs.length > 1) {
      const d = await vscode.window.showQuickPick(dbs, { title: 'Database', placeHolder: driver.defaultDatabase });
      if (d === undefined) return undefined;
      database = d;
    } else if (dbs.length === 1) {
      database = dbs[0];
    }
    const b = { connId: pick.id, database };
    await this.bind(doc, b);
    return b;
  }

  /** ⌘Enter: runs the selection (possibly several statements), otherwise the statement under the cursor. */
  async runFromEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const b = this.binding(doc) ?? (await this.pickConnection(doc).catch((e) => void vscode.window.showErrorMessage((e as Error).message)));
    if (!b) return;
    const mongo = this.isMongo(doc, b);
    let statements: StatementRange[];
    if (!editor.selection.isEmpty) {
      statements = splitFor(doc.getText(editor.selection), mongo);
    } else {
      const all = splitFor(doc.getText(), mongo);
      const one = statementAt(all, doc.offsetAt(editor.selection.active));
      statements = one ? [one] : [];
      if (one) this.flash(editor, one);
    }
    await this.run(doc, statements);
  }

  async runRange(uri: vscode.Uri, start: number, end: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText().slice(start, end);
    await this.run(doc, [{ text, start, end }]);
  }

  private flash(editor: vscode.TextEditor, st: StatementRange) {
    const deco = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground') });
    editor.setDecorations(deco, [new vscode.Range(editor.document.positionAt(st.start), editor.document.positionAt(st.end))]);
    setTimeout(() => deco.dispose(), 350);
  }

  private async run(doc: vscode.TextDocument, statements: StatementRange[]): Promise<void> {
    if (!statements.length) {
      void vscode.window.showInformationMessage('Nothing to run.');
      return;
    }
    let b = this.binding(doc);
    try {
      b ??= await this.pickConnection(doc);
      if (!b) return;
      const binding = b;
      const title = this.label(binding);
      if (!(await this.allowedBySafety(doc, binding, statements))) return;
      await this.results.reveal();
      this.results.post({ type: 'running', title, sql: statements.map((s) => s.text).join(';\n') });
      const driver = await this.manager.get(binding.connId);
      const maxRows = vscode.workspace.getConfiguration('dockdb').get('maxQueryRows', 1000);
      const items: ResultItem[] = [];
      for (const [i, st] of statements.entries()) {
        const itemTitle = statements.length > 1 ? `#${i + 1} ${firstWords(st.text)}` : firstWords(st.text);
        try {
          const r = await driver.query(binding.database, st.text, [], maxRows);
          items.push({ title: itemTitle, sql: st.text, columns: r.columns, rows: r.rows, affectedRows: r.affectedRows, durationMs: r.durationMs, truncated: r.truncated });
        } catch (e) {
          const fe = explainError(e);
          items.push({ title: itemTitle, sql: st.text, columns: [], rows: [], durationMs: 0, error: fe.message, hint: fe.hint });
          break; // stop at the first failing statement, like DataGrip
        }
      }
      this.results.post({ type: 'results', title, items });
      // Tables/collections may have been created or dropped → refresh the sidebar.
      const ddl = /^\s*(create|drop|alter|rename)\b|\.(createCollection|createView|drop|dropDatabase|renameCollection|insertOne|insertMany)\s*\(/i;
      if (items.some((it) => ddl.test(it.sql))) void vscode.commands.executeCommand('dockdb.refreshTree');
    } catch (e) {
      if (e instanceof CancelledError) return;
      this.results.post({ type: 'error', message: (e as Error).message });
    }
  }

  /** Read-only: refuse statements that write. Protected: ask before running them. */
  private async allowedBySafety(doc: vscode.TextDocument, b: Binding, statements: StatementRange[]): Promise<boolean> {
    const config = this.store.get(b.connId);
    if (!config) return false;
    const safety = safetyOf(config);
    if (safety === 'dev') return true;
    const mongo = this.isMongo(doc, b);
    const writes = statements.filter((s) => (mongo ? isWriteMongo(s.text) : isWriteSql(s.text)));
    if (!writes.length) return true;
    const first = firstWords(writes[0].text);
    if (safety === 'readonly') {
      await this.results.reveal();
      this.results.post({
        type: 'results',
        title: this.label(b),
        items: [
          {
            title: 'Blocked',
            sql: writes[0].text,
            columns: [],
            rows: [],
            durationMs: 0,
            error: `Not run: "${config.name}" is read-only, and ${writes.length === 1 ? 'this statement changes' : `${writes.length} statements change`} data (${first}).`,
            hint: 'Nothing was sent to the database. If you really mean it, right-click the connection in the sidebar → Set Safety Mode.',
          },
        ],
      });
      return false;
    }
    const detail = writes
      .slice(0, 5)
      .map((w) => `• ${w.text.replace(/\s+/g, ' ').slice(0, 140)}`)
      .join('\n');
    const answer = await vscode.window.showWarningMessage(
      `Run ${writes.length === 1 ? 'a statement that changes' : `${writes.length} statements that change`} data on "${config.name}"?`,
      { modal: true, detail: `This connection is Protected.\n\n${detail}${writes.length > 5 ? '\n…' : ''}` },
      'Run',
    );
    return answer === 'Run';
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [new vscode.CodeLens(top, { title: `$(database) ${this.label(this.binding(doc), true)}`, command: 'dockdb.pickConnection', arguments: [doc] })];
    const statements = splitFor(doc.getText(), this.isMongo(doc, this.binding(doc)));
    if (statements.length > 200) return lenses;
    for (const st of statements) {
      const pos = doc.positionAt(st.start);
      lenses.push(
        new vscode.CodeLens(new vscode.Range(pos, pos), {
          title: '$(play) Run',
          tooltip: st.text.slice(0, 200),
          command: 'dockdb.runStatement',
          arguments: [doc.uri, st.start, st.end],
        }),
      );
    }
    return lenses;
  }
}

function firstWords(sql: string): string {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > 40 ? one.slice(0, 40) + '…' : one;
}
