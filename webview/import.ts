import type { ImportPreview } from '../src/import/importPanel';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

document.head.insertAdjacentHTML(
  'beforeend',
  `<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); max-width: 860px; margin: 0 auto; padding: 24px 20px; }
  h2 { margin: 0 0 4px; font-weight: 600; }
  p.hint { margin: 0 0 14px; color: var(--vscode-descriptionForeground); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .chips code { padding: 2px 8px; border-radius: 10px; background: var(--vscode-textCodeBlock-background); font-size: 0.9em; }
  textarea { width: 100%; box-sizing: border-box; height: 240px; resize: vertical; padding: 10px;
             border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px;
             background: var(--vscode-input-background); color: var(--vscode-input-foreground);
             font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .found { margin: 16px 0; }
  .card { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 10px 12px; margin-bottom: 8px;
          border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); border-radius: 6px;
          background: var(--vscode-editorWidget-background); }
  .card b { font-weight: 600; }
  .card .kind { color: var(--vscode-descriptionForeground); text-align: right; }
  .card .meta { grid-column: 1 / -1; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: .92em; }
  .card .ok { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .card .warn { color: var(--vscode-editorWarning-foreground); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  button { height: 28px; padding: 0 14px; border: 0; border-radius: 3px; font: inherit; cursor: pointer;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
</style>`,
);

document.body.innerHTML = `
  <h2>Import a database connection</h2>
  <p class="hint">Paste anything below — DockDB figures out the database type, host, port, user and password.</p>
  <div class="chips">
    <code>docker inspect &lt;container&gt;</code><code>docker-compose.yml</code><code>docker run -e … -p …</code>
    <code>.env</code><code>postgres://user:pass@host:5432/db</code><code>mysql://…</code><code>mongodb://…</code><code>sqlite:///path/app.db</code>
  </div>
  <textarea id="text" spellcheck="false" placeholder="Paste here…"></textarea>
  <div class="found" id="found"></div>
  <div class="actions"><button id="cancel">Close</button><button id="ok" class="primary" disabled>Add</button></div>`;

const text = document.getElementById('text') as HTMLTextAreaElement;
const found = document.getElementById('found')!;
const ok = document.getElementById('ok') as HTMLButtonElement;

function render(items: ImportPreview[]) {
  ok.disabled = !items.length;
  ok.textContent = items.length > 1 ? `Add ${items.length} connections` : 'Add connection';
  if (!text.value.trim()) {
    found.innerHTML = '';
    return;
  }
  found.innerHTML = items.length
    ? items
        .map(
          (it) => `<div class="card"><b>${esc(it.name)}</b><span class="kind">${esc(it.kind)}</span>
          <span class="meta">${esc(it.target)}${it.user ? ` · user <b>${esc(it.user)}</b>` : ''}${it.database ? ` · db <b>${esc(it.database)}</b>` : ''} ·
          ${it.hasPassword ? '<span class="ok">✓ password found</span>' : '<span class="warn">password will be asked on connect</span>'}
          ${it.note ? ` · <span class="warn">${esc(it.note)}</span>` : ''}</span></div>`,
        )
        .join('')
    : '<div class="empty">No database recognized in this text yet.</div>';
}

let timer: number | undefined;
text.addEventListener('input', () => {
  clearTimeout(timer);
  timer = window.setTimeout(() => vscode.postMessage({ type: 'parse', text: text.value }), 150);
});
ok.addEventListener('click', () => vscode.postMessage({ type: 'import', text: text.value }));
document.getElementById('cancel')!.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
text.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !ok.disabled) ok.click();
});

window.addEventListener('message', (ev) => {
  const m = ev.data as { type: string; text?: string; preview: ImportPreview[] };
  if (m.type === 'init' && m.text) text.value = m.text;
  render(m.preview);
});

text.focus();
vscode.postMessage({ type: 'ready' });
