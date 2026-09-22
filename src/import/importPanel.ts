import * as vscode from 'vscode';
import { parsePastedText } from '../discovery/pasteParser';
import { DetectedDb, KIND_LABEL } from '../model';
import { ConnectionStore } from '../store/connectionStore';

export interface ImportPreview {
  name: string;
  kind: string;
  target: string;
  user?: string;
  database?: string;
  hasPassword: boolean;
  note?: string;
}

type FromImport = { type: 'ready' } | { type: 'parse'; text: string } | { type: 'import'; text: string } | { type: 'cancel' };

/** Webview for multi-line pastes: docker inspect output, docker-compose, docker run, .env or a URL. */
export class ImportPanel {
  private static current: ImportPanel | undefined;

  static show(ctx: vscode.ExtensionContext, store: ConnectionStore, onImported: (dbs: DetectedDb[]) => void): void {
    if (ImportPanel.current) return ImportPanel.current.panel.reveal();
    const panel = vscode.window.createWebviewPanel('dockdb.import', 'DockDB — Import connection', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    });
    panel.iconPath = new vscode.ThemeIcon('clippy');
    ImportPanel.current = new ImportPanel(panel, ctx, store, onImported);
    panel.onDidDispose(() => (ImportPanel.current = undefined));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly onImported: (dbs: DetectedDb[]) => void,
  ) {
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview', 'import.js'));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head><body><script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((m: FromImport) => this.handle(m));
  }

  private async handle(m: FromImport) {
    if (m.type === 'ready') {
      // The clipboard holds something recognizable → prefill it.
      const clip = await vscode.env.clipboard.readText();
      const text = clip.length < 2_000_000 && parsePastedText(clip).length ? clip : '';
      void this.panel.webview.postMessage({ type: 'init', text, preview: preview(parsePastedText(text)) });
    } else if (m.type === 'parse') {
      void this.panel.webview.postMessage({ type: 'preview', preview: preview(parsePastedText(m.text)) });
    } else if (m.type === 'import') {
      const dbs = parsePastedText(m.text);
      for (const db of dbs) await this.store.save(db, db.password);
      this.onImported(dbs);
      this.panel.dispose();
    } else {
      this.panel.dispose();
    }
  }
}

function preview(dbs: DetectedDb[]): ImportPreview[] {
  return dbs.map((d) => ({
    name: d.name,
    kind: KIND_LABEL[d.kind],
    target: d.kind === 'sqlite' ? d.file ?? '' : `${d.host}:${d.port}`,
    user: d.user,
    database: d.database,
    hasPassword: d.password !== undefined,
    note: d.note,
  }));
}
