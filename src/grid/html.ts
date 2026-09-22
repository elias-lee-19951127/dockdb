import * as vscode from 'vscode';

export function gridHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const asset = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', p));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('grid.css')}">
</head>
<body>
<script nonce="${nonce}" src="${asset('grid.js')}"></script>
</body>
</html>`;
}
