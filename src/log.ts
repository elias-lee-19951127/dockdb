import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;
/** The last few hundred events — read by the integration tests to see the webview loaded and replied. */
export const trace: string[] = [];

export function log(event: string, detail?: string): void {
  trace.push(detail ? `${event} ${detail}` : event);
  if (trace.length > 500) trace.shift();
  channel ??= vscode.window.createOutputChannel('DockDB', { log: true });
  if (event.includes('error')) channel.error(event, detail ?? '');
  else channel.debug(event, detail ?? '');
}
