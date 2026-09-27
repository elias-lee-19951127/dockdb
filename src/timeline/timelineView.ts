import * as vscode from 'vscode';
import { log } from '../log';
import { isWriteSql } from '../safety';
import { inlineParams, summarizePlan } from './analyze';
import { FromTimeline, ToTimeline } from './protocol';
import { QueryRecorder } from './recorder';

export interface TimelineActions {
  openQuery(connId: string, database: string, sql: string): Promise<unknown>;
  openTable(connId: string, database: string, table: string): Promise<unknown>;
}

/** The "Query Timeline" view in the bottom panel: queries apps ran, grouped by user action. */
export class TimelineView implements vscode.WebviewViewProvider {
  static readonly id = 'dockdb.timeline';
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private lastError: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly recorder: QueryRecorder,
    private readonly actions: TimelineActions,
  ) {
    recorder.onQueries((queries) => this.post({ type: 'queries', queries }));
    recorder.onState((s) => {
      this.lastError = s.error;
      this.postState();
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
    view.webview.html = html(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((m: FromTimeline) => void this.handle(m));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  async reveal(): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${TimelineView.id}.focus`);
  }

  /** Candidates change as connections are found, saved or switched to Dev. */
  postState(): void {
    this.post({
      type: 'state',
      recording: this.recorder.state.recording,
      candidates: this.recorder.candidates().map((c) => ({ id: c.id, name: c.name })),
      error: this.lastError,
    });
  }

  private async handle(m: FromTimeline): Promise<void> {
    log(`timeline:recv:${m.type}`, m.type === 'client-error' ? `client-error ${m.message}` : undefined);
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.postState();
          this.post({ type: 'queries', queries: this.recorder.queries, reset: true });
          break;
        case 'start':
          this.lastError = undefined;
          await this.recorder.start(m.connId);
          break;
        case 'stop':
          await this.recorder.stop();
          break;
        case 'clear':
          this.recorder.clear();
          this.post({ type: 'queries', queries: [], reset: true });
          break;
        case 'explain': {
          const q = this.recorder.get(m.id);
          if (!q) break;
          try {
            // Statements that write are only planned, never run.
            const plan = await this.recorder.explain(m.id, !isWriteSql(q.sql));
            this.post({ type: 'explain', id: m.id, summary: summarizePlan(plan) });
          } catch (e) {
            this.post({ type: 'explain', id: m.id, error: (e as Error).message });
          }
          break;
        }
        case 'open-sql': {
          const q = this.recorder.get(m.id);
          if (q && this.recorder.lastConnId) await this.actions.openQuery(this.recorder.lastConnId, q.database, inlineParams(q.sql, q.params) + '\n');
          break;
        }
        case 'open-table': {
          const q = this.recorder.get(m.id);
          if (q && this.recorder.lastConnId) await this.actions.openTable(this.recorder.lastConnId, q.database, m.table);
          break;
        }
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          void vscode.window.setStatusBarMessage('Copied', 1500);
          break;
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      this.postState();
    }
  }

  private post(m: ToTimeline): void {
    if (m.type !== 'queries') log(`timeline:send:${m.type}`, m.type === 'explain' ? (m.error ? `error ${m.error}` : 'ok') : undefined);
    if (this.view && this.ready) void this.view.webview.postMessage(m);
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const asset = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', p));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('timeline.css')}">
</head>
<body>
<script nonce="${nonce}" src="${asset('timeline.js')}"></script>
</body>
</html>`;
}
