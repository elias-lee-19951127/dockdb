// Renders the README screenshots and GIFs into docs/images/.
//
// The grid, results, timeline and import webviews are the real ones (dist/webview/*.js), driven by the
// real SQLite driver / paste parser / EXPLAIN summarizer. VS Code itself (title bar, sidebar tree,
// editor) is drawn around them in plain HTML, so this runs without VS Code or Docker.
//
//   npm run build && node scripts/readme-media/capture.mjs [scene…]
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// Playwright is not a dependency: use the one installed globally (npx playwright install chromium).
const { chromium } = require('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root, 'docs/images');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockdb-media-'));
const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
const codicons = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
const W = 1280;
const H = 760;

fs.mkdirSync(outDir, { recursive: true });
await esbuild.build({ entryPoints: [path.join(import.meta.dirname, 'host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(tmp, 'host.cjs'), logLevel: 'error' });
const host = require(path.join(tmp, 'host.cjs'));

// ───────────────────────── demo database ─────────────────────────

const initSqlJs = require('sql.js');
const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
const SEED = fs.readFileSync(path.join(import.meta.dirname, 'seed.sql'), 'utf8');
function freshDb() {
  const db = new SQL.Database();
  db.exec(SEED);
  const file = path.join(tmp, 'shop.db');
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return file;
}

// ───────────────────────── VS Code look ─────────────────────────

const THEME = `
  --vscode-font-family: Inter, "Segoe UI", system-ui, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: "DejaVu Sans Mono", Menlo, monospace; --vscode-editor-font-size: 13px;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d; --vscode-errorForeground: #f85149;
  --vscode-editor-background: #1f1f1f; --vscode-sideBar-background: #181818; --vscode-panel-background: #181818;
  --vscode-panel-border: #2b2b2b; --vscode-editorGroup-border: #2b2b2b; --vscode-sideBarSectionHeader-background: #181818;
  --vscode-editorWidget-background: #202020; --vscode-editorWidget-border: #313131;
  --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1; --vscode-button-border: #ffffff12;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-charts-blue: #3794ff; --vscode-charts-green: #89d185; --vscode-charts-orange: #d18616; --vscode-charts-purple: #b180d7; --vscode-charts-red: #f14c4c; --vscode-charts-yellow: #cca700;
  --vscode-dropdown-background: #313131; --vscode-dropdown-border: #3c3c3c; --vscode-dropdown-foreground: #cccccc;
  --vscode-editorWarning-foreground: #cca700; --vscode-focusBorder: #0078d4; --vscode-gitDecoration-addedResourceForeground: #81b88b;
  --vscode-input-background: #313131; --vscode-input-border: #3c3c3c; --vscode-input-foreground: #cccccc; --vscode-input-placeholderForeground: #989898;
  --vscode-inputValidation-errorBackground: #5a1d1d; --vscode-inputValidation-errorBorder: #be1100;
  --vscode-list-activeSelectionBackground: #04395e; --vscode-list-activeSelectionForeground: #ffffff; --vscode-list-hoverBackground: #2a2d2e;
  --vscode-menu-background: #1f1f1f; --vscode-menu-border: #454545; --vscode-menu-foreground: #cccccc;
  --vscode-menu-selectionBackground: #0078d4; --vscode-menu-selectionForeground: #ffffff; --vscode-menu-separatorBackground: #454545;
  --vscode-progressBar-background: #0078d4; --vscode-symbolIcon-keywordForeground: #cccccc;
  --vscode-textBlockQuote-background: #2b2b2b; --vscode-textCodeBlock-background: #2b2b2b; --vscode-textLink-foreground: #4daafc;
  --vscode-toolbar-hoverBackground: #5a5d5e50;`;

const css = (p) => pathToFileURL(p).href;

/** A webview document: theme variables + the real bundle, with acquireVsCodeApi wired to the host. */
function webviewHtml(name, script, style) {
  const file = path.join(tmp, `${name}.html`);
  fs.writeFileSync(
    file,
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>html{${THEME}} body{margin:0;padding:0}</style>
${style ? `<link rel="stylesheet" href="${css(path.join(root, 'dist/webview', style))}">` : ''}
<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__host(${JSON.stringify(name)}, m), getState() {}, setState() {} });</script>
</head><body class="vscode-dark"><script src="${css(path.join(root, 'dist/webview', script))}"></script></body></html>`,
  );
  return pathToFileURL(file).href;
}

const ci = (name, color) => `<i class="codicon codicon-${name}"${color ? ` style="color:${color}"` : ''}></i>`;

/** Sidebar tree rows: [depth, icon, label, description?, {open, selected, color}] */
function tree(rows) {
  return rows
    .map(([depth, icon, label, desc, o = {}]) => {
      const twisty = o.leaf ? '' : ci(o.open ? 'chevron-down' : 'chevron-right');
      return `<div class="row ${o.selected ? 'sel' : ''}" style="padding-left:${8 + depth * 14}px"><span class="tw">${twisty}</span>${ci(icon, o.color)}<span class="lbl">${label}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</div>`;
    })
    .join('');
}

/** The sidebar as DockDB shows it after a scan, with `selected` (a shop.db table) highlighted. */
const sidebar = (selected) => [
  [0, 'database', 'shop-postgres', 'Postgres 16.4 · docker', { color: '#3794ff' }],
  [0, 'circle-large-outline', 'billing-mysql', 'MySQL 8.4 · docker', { color: '#d18616' }],
  [0, 'circle-large-outline', 'reports-mssql', 'SQL Server 2022 · port', { color: '#f14c4c' }],
  [0, 'circle-large-outline', 'events-mongo', 'MongoDB 7.0 · docker', { color: '#89d185' }],
  [0, 'circle-large-outline', 'staging', '🛡 protected · Postgres 15.8', { color: '#3794ff' }],
  [0, 'database', 'shop.db', 'SQLite · file', { open: true, color: '#b180d7' }],
  ...['customers', 'orders', 'products'].map((t) => [1, 'table', t, '', { leaf: true, selected: t === selected }]),
];

function frameHtml({ title, tabs, editor, panel, sidebar: side = sidebar(), panelTabs = ['Results', 'Query Timeline'], activePanel = 0, panelHeight = 300 }) {
  const file = path.join(tmp, `frame-${Math.random().toString(36).slice(2)}.html`);
  const tabBar = tabs.map((t, i) => `<div class="tab ${i === 0 ? 'on' : ''}">${ci(t.icon, t.color)}<span>${t.label}</span>${i === 0 ? ci('close') : ''}</div>`).join('');
  fs.writeFileSync(
    file,
    `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${css(path.join(codicons, 'codicon.css'))}">
<style>
html{${THEME}} *{box-sizing:border-box}
body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#1f1f1f;color:var(--vscode-foreground);font:13px var(--vscode-font-family);display:grid;grid-template-rows:35px 1fr 22px}
.title{background:#181818;border-bottom:1px solid #2b2b2b;display:flex;align-items:center;justify-content:center;position:relative;color:#9d9d9d;font-size:12px}
.title .dots{position:absolute;left:12px;display:flex;gap:8px}.title .dots i{width:12px;height:12px;border-radius:50%;display:block}
.title .cmd{background:#2a2a2a;border:1px solid #3c3c3c;border-radius:6px;width:420px;height:22px;display:flex;align-items:center;justify-content:center;gap:6px}
.body{display:grid;grid-template-columns:48px 270px 1fr;min-height:0}
.act{background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;align-items:center;padding-top:6px;gap:4px}
.act i{font-size:24px;color:#868686;width:48px;height:48px;display:flex;align-items:center;justify-content:center}
.act i.on{color:#d7d7d7;border-left:2px solid #0078d4}
.side{background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;min-width:0}
.side h3{margin:0;height:35px;display:flex;align-items:center;padding:0 8px 0 20px;font-size:11px;font-weight:400;letter-spacing:.04em;color:#bbb}
.side h3 span{flex:1}.side h3 i{font-size:16px;margin-left:6px;color:#ccc}
.side h4{margin:0;height:22px;display:flex;align-items:center;font-size:11px;font-weight:700;padding-left:4px;color:#ccc}
.row{height:22px;display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;padding-right:8px}
.row .tw{width:16px;display:inline-flex}.row .tw i{font-size:14px}
.row i{font-size:16px}.row .lbl{margin-left:2px}.row .desc{color:#9d9d9d;font-size:12px;margin-left:6px;overflow:hidden;text-overflow:ellipsis}
.row.sel{background:#04395e;outline:1px solid #0078d4;outline-offset:-1px}
.main{display:grid;grid-template-rows:35px 1fr ${panel ? `${panelHeight}px` : ''};min-width:0;min-height:0}
.tabs{background:#181818;display:flex;border-bottom:1px solid #2b2b2b}
.tab{display:flex;align-items:center;gap:6px;padding:0 10px 0 12px;border-right:1px solid #2b2b2b;color:#9d9d9d;font-size:13px}
.tab.on{background:#1f1f1f;color:#fff;border-top:1px solid #0078d4;margin-bottom:-1px}.tab i{font-size:16px}.tab .codicon-close{font-size:14px;margin-left:6px}
iframe{border:0;width:100%;height:100%;display:block;background:#1f1f1f}
.panel{border-top:1px solid #2b2b2b;display:grid;grid-template-rows:35px 1fr;min-height:0;background:#181818}
.ptabs{display:flex;gap:18px;align-items:center;padding-left:16px;font-size:11px;letter-spacing:.04em;color:#9d9d9d}
.ptabs span{padding:8px 0}.ptabs span.on{color:#e7e7e7;border-bottom:1px solid #0078d4}
.status{background:#181818;border-top:1px solid #2b2b2b;display:flex;align-items:center;gap:14px;padding:0 10px;font-size:12px;color:#9d9d9d}
.status i{font-size:14px;vertical-align:-3px}
#cursor{position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:99;transition:none}
#cursor.down svg{transform:scale(.85)}
</style></head><body>
<div class="title"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><div class="cmd">${ci('search')}<span>${title}</span></div></div>
<div class="body">
  <div class="act">${ci('files')}${ci('search')}${ci('source-control')}${ci('debug-alt')}${ci('extensions')}<i class="codicon codicon-database on"></i></div>
  <div class="side">
    <h3><span>DOCKDB</span>${ci('search')}${ci('refresh')}${ci('clippy')}${ci('add')}</h3>
    <h4>${ci('chevron-down')}DATABASES</h4>
    <div id="tree">${tree(side)}</div>
  </div>
  <div class="main">
    <div class="tabs">${tabBar}</div>
    <div id="editor">${editor}</div>
    ${panel ? `<div class="panel"><div class="ptabs">${panelTabs.map((t, i) => `<span class="${i === activePanel ? 'on' : ''}">${t.toUpperCase()}</span>`).join('')}</div><div id="panel">${panel}</div></div>` : ''}
  </div>
</div>
<div class="status">${ci('remote')}<span>${ci('source-control')} main</span><span style="flex:1"></span><span>${ci('database')} shop.db</span><span>UTF-8</span></div>
<div id="cursor" hidden><svg width="20" height="20" viewBox="0 0 20 20"><path d="M3 2l12 9.5-5.2.6 3 6-2.3 1.1-3-6L3 17z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg></div>
</body></html>`,
  );
  return pathToFileURL(file).href;
}

const iframe = (name, src) => `<iframe name="${name}" src="${src}"></iframe>`;

// ───────────────────────── Playwright helpers ─────────────────────────

const browser = await chromium.launch();

/** Opens a frame; `hosts` maps a webview name to a function handling its messages: (msg, post) => void. */
async function open(frameOpts, hosts, { video } = {}) {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: video ? 1 : 2,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const posters = {};
  await page.exposeBinding('__host', async (_src, name, msg) => hosts[name]?.(msg, posters[name]));
  for (const name of Object.keys(hosts))
    posters[name] = (m) => page.frame({ name })?.evaluate((msg) => window.postMessage(msg, '*'), m);
  await page.goto(frameHtml(frameOpts));
  await page.waitForLoadState('load');
  return { page, context, frame: (name) => page.frame({ name }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake mouse pointer (headless Chromium has none), moved smoothly. */
function pointer(page) {
  record(page);
  let x = W / 2;
  let y = H / 2;
  const place = () => page.evaluate(([x, y]) => {
    const c = document.getElementById('cursor');
    c.hidden = false;
    c.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
  }, [x, y]);
  const api = {
    async to(tx, ty, ms = 450) {
      const steps = Math.max(1, Math.round(ms / 16));
      const [sx, sy] = [x, y];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        x = sx + (tx - sx) * e;
        y = sy + (ty - sy) * e;
        await page.mouse.move(x, y);
        await place();
        await sleep(16);
      }
    },
    async toEl(locator, ms, dx = 0.5, dy = 0.5) {
      const b = await locator.boundingBox();
      await api.to(b.x + b.width * dx, b.y + b.height * dy, ms);
    },
    async click(locator, opts = {}) {
      if (locator) await api.toEl(locator, opts.ms);
      await page.evaluate(() => document.getElementById('cursor').classList.add('down'));
      if (opts.double) await page.mouse.dblclick(x, y);
      else await page.mouse.click(x, y, { button: opts.button ?? 'left' });
      await page.evaluate(() => document.getElementById('cursor').classList.remove('down'));
      await sleep(opts.after ?? 350);
    },
    show: place,
  };
  return api;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`✓ docs/images/${name}.png`);
}

const recordings = new WeakMap();

/** Screenshots the page continuously (lossless frames keep GIFs small, unlike a screen video). */
function record(page) {
  const frames = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      frames.push({ t, buf: await page.screenshot() });
      await sleep(Math.max(0, 70 - (Date.now() - t)));
    }
  })();
  recordings.set(page, async () => {
    on = false;
    await loop;
    return frames;
  });
}

/** Stops recording, closes the context and turns the frames into an optimized GIF. */
async function gif(page, context, name, { width = 960 } = {}) {
  const frames = await recordings.get(page)();
  await context.close();
  const dir = fs.mkdtempSync(path.join(tmp, 'frames-'));
  const list = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `${String(i).padStart(5, '0')}.png`);
    fs.writeFileSync(file, f.buf);
    const next = frames[i + 1]?.t ?? f.t + 1500; // hold the last frame
    list.push(`file '${file}'`, `duration ${((next - f.t) / 1000).toFixed(3)}`);
  });
  list.push(list.at(-2));
  fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));
  const out = path.join(outDir, `${name}.gif`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', `fps=15,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0', out]);
  console.log(`✓ docs/images/${name}.gif (${Math.round(fs.statSync(out).size / 1024)} KB, ${((frames.at(-1).t - frames[0].t) / 1000).toFixed(1)} s)`);
}

function grid(file, table, safety = 'dev') {
  return (msg, post) => {
    const handler = (grid.handlers[table + safety] ??= host.gridHost(file, wasmDir, table, safety, (m) => post(m)));
    return handler(msg);
  };
}
grid.handlers = {};

const gridTab = (label, color = '#cccccc') => ({ icon: 'table', label, color });

// ───────────────────────── scenes ─────────────────────────

const cell = (f, r, c) => f.locator(`tbody tr[data-r="${r}"] td`).nth(c + 1);
const menuItem = (f, text) => f.locator('#menu button', { hasText: text }).first();
const type = (page, text, delay = 85) => page.keyboard.type(text, { delay });

/** A table open in the editor area, sidebar showing it selected. */
async function openGrid(table, { safety = 'dev', video, db = freshDb(), tabs } = {}) {
  grid.handlers = {};
  const s = await open(
    {
      title: 'shop — DockDB',
      tabs: tabs ?? [gridTab(table), gridTab(table === 'orders' ? 'customers' : 'orders')],
      editor: iframe('grid', webviewHtml('grid', 'grid.js', 'grid.css')),
      sidebar: sidebar(table),
    },
    { grid: grid(db, table, safety) },
    { video },
  );
  const f = s.frame('grid');
  await f.waitForSelector('tbody tr');
  await sleep(250);
  return { ...s, f, db };
}

/** Plain-HTML stand-in for VS Code's text editor (the editor is not a webview). */
function codeEditor(lines, { lens = [], header } = {}) {
  const kw = /\b(SELECT|FROM|WHERE|JOIN|ON|GROUP BY|ORDER BY|LIMIT|AS|AND|DESC|COUNT|SUM|ROUND|const|await|return|async|function)\b/g;
  const hl = (l) =>
    l
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/('[^']*')/g, '<span style="color:#ce9178">$1</span>')
      .replace(/(--.*)$/, '<span style="color:#6a9955">$1</span>')
      .replace(kw, '<span style="color:#569cd6">$1</span>')
      .replace(/\b(\d+)\b(?![^<]*>)/g, '<span style="color:#b5cea8">$1</span>');
  let n = 0;
  const rows = lines.map((l, i) => {
    const lensRow = lens.includes(i) ? `<div class="ln"><span class="num"></span><span class="lens">▶ Run  ·  Copy</span></div>` : '';
    return `${lensRow}<div class="ln ${i === 2 ? 'cur' : ''}"><span class="num">${++n}</span><span>${hl(l) || '&nbsp;'}</span></div>`;
  });
  return `<style>.code{height:100%;background:#1f1f1f;font:13px/20px var(--vscode-editor-font-family);padding-top:4px;overflow:hidden}
    .ln{display:flex;white-space:pre}.ln.cur{background:#2a2d2e55}.num{width:52px;text-align:right;padding-right:18px;color:#6e7681;flex:none}
    .lens{color:#999;font:11px var(--vscode-font-family)}
    .bind{color:#999;font:11px/20px var(--vscode-font-family);padding-left:70px}</style>
    <div class="code">${header ? `<div class="bind">${header}</div>` : ''}${rows.join('')}</div>`;
}

const scenes = {
  async hero() {
    const { page, context } = await openGrid('customers');
    await shot(page, 'hero');
    await context.close();
  },

  async filter() {
    const { page, context, f } = await openGrid('orders', { video: true });
    const p = pointer(page);
    await p.show();
    await sleep(500);
    // search across every column
    await p.click(f.locator('#search'));
    await type(page, 'gift');
    await sleep(1500);
    await page.keyboard.press('Escape');
    await sleep(900);
    // right-click a cell → Filter by value
    await p.click(cell(f, 0, 5), { button: 'right', after: 700 });
    await p.click(menuItem(f, 'Filter by value'), { after: 1400 });
    // column menu → greater than…
    await p.click(f.locator('.colmenu[data-c="4"]'), { after: 700 });
    await p.click(menuItem(f, 'greater than'), { after: 500 });
    await type(page, '100', 120);
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(2200);
    await gif(page, context, 'filter');
  },

  async edit() {
    const { page, context, f } = await openGrid('customers', { video: true });
    const p = pointer(page);
    await p.show();
    await sleep(400);
    // type over a cell
    await p.click(cell(f, 1, 3), { after: 300 });
    await type(page, 'Da Nang');
    await page.keyboard.press('Enter');
    await sleep(500);
    // add a row
    await p.click(f.locator('#add-row'), { after: 400 });
    await type(page, 'Mai Pham');
    await page.keyboard.press('Tab');
    await type(page, 'mai.pham@example.com', 55);
    await page.keyboard.press('Tab');
    await type(page, 'Hue');
    await page.keyboard.press('Enter');
    await sleep(600);
    // review what will run, then save
    await p.click(f.locator('#preview'), { after: 2600 });
    await p.click(f.locator('#m-save'), { after: 2000 });
    await gif(page, context, 'edit');
  },

  async details() {
    const { page, context, f } = await openGrid('customers');
    await cell(f, 2, 1).click();
    await f.locator('#toggle-details').click();
    await sleep(400);
    await shot(page, 'details');
    await context.close();
  },

  async errors() {
    const { page, context, f } = await openGrid('customers');
    await f.locator('#add-row').click();
    await type(page, 'Ana Silva', 0);
    await page.keyboard.press('Tab');
    await type(page, 'ana.silva@example.com', 0);
    await page.keyboard.press('Enter');
    await f.locator('#save').click();
    await f.waitForSelector('#banner:not([hidden])');
    await sleep(300);
    await shot(page, 'errors');
    await context.close();
  },

  async safety() {
    const { page, context, f } = await openGrid('orders', { safety: 'protected' });
    await cell(f, 0, 5).click();
    await type(page, 'shipped', 0);
    await page.keyboard.press('Enter');
    await cell(f, 3, 3).click();
    await type(page, '2', 0);
    await page.keyboard.press('Enter');
    await f.locator('#save').click();
    await f.waitForSelector('#modal:not([hidden])');
    await sleep(300);
    await shot(page, 'safety');
    await context.close();
  },

  async query() {
    const db = freshDb();
    const sql = [
      '-- Best customers this autumn',
      'SELECT c.name, c.city, COUNT(*) AS orders, ROUND(SUM(o.total), 2) AS spent',
      'FROM orders o JOIN customers c ON c.id = o.customer_id',
      "WHERE o.status <> 'refunded'",
      'GROUP BY c.id ORDER BY spent DESC LIMIT 10;',
      '',
      'SELECT status, COUNT(*) AS n FROM orders GROUP BY status;',
    ];
    const statements = [sql.slice(1, 5).join('\n'), sql[6]];
    const items = await host.runQueries(db, wasmDir, statements);
    const { page, context } = await open(
      {
        title: 'shop — DockDB',
        tabs: [{ icon: 'file-code', label: 'report.sql', color: '#e8a23c' }, gridTab('customers')],
        editor: codeEditor(sql, { lens: [1, 6], header: '⛁ shop.db · main — click to change' }),
        panel: iframe('results', webviewHtml('results', 'grid.js', 'grid.css')),
        panelHeight: 330,
      },
      { results: (m, post) => m.type === 'ready' && post({ type: 'results', title: 'shop.db · main', items }) },
    );
    await page.frame({ name: 'results' }).waitForSelector('tbody tr');
    await sleep(300);
    await shot(page, 'query');
    await context.close();
  },

  async timeline() {
    const now = Date.parse('2026-10-27T09:14:03.120Z');
    const queries = host.timelineQueries(now);
    let feed;
    const { page, context, frame } = await open(
      {
        title: 'shop-api — DockDB',
        tabs: [{ icon: 'file-code', label: 'orders.service.ts', color: '#3178c6' }],
        editor: codeEditor([
          'async function orderHistory(userId: number) {',
          '  const orders = await db.order.findMany({ where: { userId }, take: 20 })',
          '  for (const o of orders) {',
          '    o.product = await db.product.findUnique({ where: { id: o.productId } })',
          '  }',
          '  return orders',
          '}',
        ]),
        panel: iframe('timeline', webviewHtml('timeline', 'timeline.js', 'timeline.css')),
        panelTabs: ['Results', 'Query Timeline'],
        activePanel: 1,
        panelHeight: 540,
      },
      {
        timeline: async (m, post) => {
          if (m.type === 'ready') {
            post({ type: 'state', recording: { connId: 'pg', name: 'shop-postgres', since: now - 4000 }, candidates: [{ id: 'pg', name: 'shop-postgres' }] });
            feed = async () => {
              for (const q of queries) {
                post({ type: 'queries', queries: [q] });
                await sleep(q.id <= 2 ? 250 : 90);
              }
            };
          } else if (m.type === 'explain') {
            await sleep(700);
            post({ type: 'explain', id: m.id, summary: host.ordersSummary });
          }
        },
      },
      { video: true },
    );
    const f = frame('timeline');
    await f.waitForSelector('#bar .rec');
    const p = pointer(page);
    await p.show();
    await sleep(600);
    await feed();
    await sleep(1200);
    await p.click(f.locator('.q:has(.dur.slow)').first(), { after: 900 });
    await p.click(f.locator('#explain'), { after: 3800 });
    await gif(page, context, 'timeline');
  },

  async import() {
    const compose = `services:
  db:
    image: postgres:16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: s3cret
      POSTGRES_DB: shop`;
    const { page, context, frame } = await open(
      {
        title: 'shop — DockDB',
        tabs: [{ icon: 'clippy', label: 'DockDB — Import connection' }],
        editor: iframe('import', webviewHtml('import', 'import.js')),
      },
      {
        import: (m, post) => {
          if (m.type === 'ready') post({ type: 'init', text: compose, preview: host.importPreview(compose) });
          if (m.type === 'parse') post({ type: 'preview', preview: host.importPreview(m.text) });
        },
      },
    );
    await frame('import').waitForSelector('.card');
    await sleep(300);
    await shot(page, 'import');
    await context.close();
  },
};

const wanted = process.argv.slice(2);
for (const [name, run] of Object.entries(scenes)) if (!wanted.length || wanted.includes(name)) await run();
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
