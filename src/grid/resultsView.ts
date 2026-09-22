import * as vscode from 'vscode';
import { log } from '../log';
import { gridHtml } from './html';
import { FromWebview, ToWebview } from './protocol';

/** The "Results" view in the bottom panel — shows results of queries run from an editor. */
export class ResultsView implements vscode.WebviewViewProvider {
  static readonly id = 'dockdb.results';
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private queue: ToWebview[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
    view.webview.html = gridHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      log(`results:recv:${m.type}`, m.type === 'client-error' ? `error ${m.message}` : undefined);
      if (m.type === 'ready') {
        this.ready = true;
        const pending = this.queue;
        this.queue = [];
        pending.forEach((msg) => void view.webview.postMessage(msg));
      } else if (m.type === 'info') {
        void vscode.window.showInformationMessage(m.message);
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand(`${ResultsView.id}.focus`);
    // Give focus back to the editor so typing can continue.
    if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }

  post(m: ToWebview): void {
    const detail = m.type === 'results' ? m.items.map((it) => (it.error ? `error(${it.error})` : `${it.rows.length}rows`)).join(',') : m.type === 'error' ? m.message : undefined;
    log(`results:send:${m.type}`, detail);
    // Keep only the latest message of each type until the webview is ready.
    if (this.view && this.ready) void this.view.webview.postMessage(m);
    else this.queue = [...this.queue.filter((q) => q.type !== m.type), m];
  }
}
