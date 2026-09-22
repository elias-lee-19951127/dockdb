// Runs INSIDE VS Code (extension host), launched by test/e2e/run.mjs — like pressing F5 and clicking around.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${ms}ms: ${what}`); })]);

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: e.message });
  }
}

async function waitTrace(api, predicate, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = api.trace.find(predicate);
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`not found in the log: ${what}\n  last events: ${api.trace.slice(-8).join(' | ')}`);
}

exports.run = async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'dockdb');
  const api = await ext.activate();
  const label = (n) => (n.type === 'table' ? n.table.name : n.type === 'database' ? `[db] ${n.database}` : n.type === 'schema' ? `[schema] ${n.schema}` : n.label);

  await check('DockDB sidebar opens', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.dockdb');
    return 'ok';
  });

  let conns = [];
  await check('Discovers Docker + ports + SQLite', async () => {
    await withTimeout(vscode.commands.executeCommand('dockdb.discover'), 30000, 'discover');
    conns = api.store.all();
    return conns.map((c) => `${c.name} (${c.kind} ${c.kind === 'sqlite' ? path.basename(c.file) : `${c.host}:${c.port}`})`);
  });

  const tableNodes = {};
  for (const c of conns) {
    await check(`Connects to ${c.name}`, async () => {
      const kids = await withTimeout(api.explorer.getChildren({ type: 'connection', config: c }), 25000, 'getChildren');
      const errs = kids.filter((k) => k.type === 'info' && k.icon === 'error');
      if (errs.length) throw new Error(errs.map((k) => k.label).join('; '));
      for (const k of kids) if (k.type === 'table') tableNodes[`${c.name}/${k.table.name}`] = k;
      // expand one more level for database nodes
      const nested = [];
      for (const k of kids.filter((k) => k.type === 'database' || k.type === 'schema').slice(0, 3)) {
        const sub = await withTimeout(api.explorer.getChildren(k), 20000, 'children');
        for (const s of sub) if (s.type === 'table') tableNodes[`${c.name}/${s.table.name}`] = s;
        nested.push(`${label(k)}: ${sub.map(label).slice(0, 6).join(', ')}`);
      }
      const saved = api.store.isSaved(c.id) ? 'auto-saved' : 'NOT saved';
      return `${kids.map(label).slice(0, 8).join(', ')}${nested.length ? ' → ' + nested.join(' | ') : ''} · ${saved} · version ${api.manager.versions.get(c.id) ?? '?'}`;
    });
  }

  for (const key of ['dockdb-test-mysql/users', 'dockdb-test-mongo/users', 'shop.db/products', 'dockdb-test-mariadb/posts', 'dockdb-test-mongo-rs/items']) {
    await check(`Opens grid ${key} (real webview)`, async () => {
      const node = tableNodes[key];
      if (!node) throw new Error('table not found in the tree');
      const name = node.table.name;
      const mark = api.trace.length;
      await vscode.commands.executeCommand('dockdb.openTable', node);
      const since = (p) => (t, i) => i >= mark && p(t);
      await waitTrace(api, since((t) => t === `table:recv:ready ${name}`), 15000, 'webview sent ready');
      const page = await waitTrace(api, since((t) => t.startsWith(`table:send:page ${name}`)), 15000, 'sent a page of rows');
      await waitTrace(api, since((t) => t.startsWith('table:send:total')), 15000, 'counted rows');
      await sleep(500);
      const errs = api.trace.slice(mark).filter((t) => t.includes('error'));
      if (errs.length) throw new Error(errs.join(' | '));
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return `${page.replace('table:send:page ', '')} · tab "${tab?.label}"`;
    });
  }

  const runIn = async (connName, db, text, lang) => {
    const c = conns.find((x) => x.name === connName);
    const mark = api.trace.length;
    await api.runner.newQuery(c.id, db, text);
    const editor = vscode.window.activeTextEditor;
    if (editor.document.languageId !== lang) throw new Error(`language ${editor.document.languageId}, expected ${lang}`);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', editor.document.uri);
    await vscode.commands.executeCommand('dockdb.runQuery');
    const sent = await waitTrace(api, (t, i) => i >= mark && t.startsWith('results:send:results'), 20000, 'query results');
    await waitTrace(api, (t) => t === 'results:recv:ready', 15000, 'Results panel ready');
    await sleep(500);
    const errs = api.trace.slice(mark).filter((t) => t.includes('client-error'));
    if (errs.length) throw new Error(errs.join(' | '));
    return `${sent.replace('results:send:results ', '')} · CodeLens: ${lenses.map((l) => l.command?.title).join(' | ')}`;
  };

  await check('Query editor MongoDB (⌘Enter)', () =>
    runIn('dockdb-test-mongo', 'shop', 'db.users.find({}, { name: 1, age: 1, _id: 0 })\n  .sort({ age: -1 })\n\ndb.users.countDocuments({})', 'dockdb-mongo'));
  await check('Query editor MySQL (⌘Enter)', () => runIn('dockdb-test-mysql', 'shop', 'SELECT id, email FROM users ORDER BY id;\n\nSELECT COUNT(*) FROM logs;', 'sql'));
  await check('Query editor SQLite (⌘Enter)', () => runIn('shop.db', 'main', 'SELECT name, price FROM products WHERE price > 20000;', 'sql'));
  await check('A failing query shows a readable error', async () => {
    const c = conns.find((x) => x.name === 'dockdb-test-mongo');
    const mark = api.trace.length;
    await api.runner.newQuery(c.id, 'shop', 'db.users.find({ age: })');
    vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('dockdb.runQuery');
    return (await waitTrace(api, (t, i) => i >= mark && t.startsWith('results:send:results'), 20000, 'error result')).replace('results:send:results ', '');
  });

  await check('*.mongo.js files get the MongoDB Shell language', async () => {
    const ws = vscode.workspace.workspaceFolders[0].uri;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(ws, 'demo.mongo.js'));
    if (doc.languageId !== 'dockdb-mongo') throw new Error(doc.languageId);
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    return `languageId=${doc.languageId}, ${lenses.length} CodeLens`;
  });

  await check('Foreign keys, search and friendly errors (MySQL)', async () => {
    const c = conns.find((x) => x.name === 'dockdb-test-mysql');
    const d = await api.manager.get(c.id);
    await d.query('shop', 'DROP TABLE IF EXISTS orders');
    await d.query('shop', 'CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, note VARCHAR(100), FOREIGN KEY (user_id) REFERENCES users(id))');
    const users = await d.query('shop', 'SELECT id FROM users ORDER BY id LIMIT 1');
    await d.query('shop', `INSERT INTO orders (user_id, note) VALUES (${users.rows[0][0]}, 'Gift wrap please'), (${users.rows[0][0]}, 'fast')`);
    const t = d.openTable({ database: 'shop', name: 'orders', type: 'table' });
    const meta = await t.meta();
    const fk = meta.columns.find((col) => col.name === 'user_id').references;
    if (!fk || fk.table.name !== 'users' || fk.column !== 'id') throw new Error(`FK not detected: ${JSON.stringify(fk)}`);
    const found = await t.page('', 'GIFT', null, 50, 0);
    if (found.rows.length !== 1) throw new Error(`search returned ${found.rows.length} rows`);
    const err = await t.save([{ type: 'insert', values: { user_id: '999999' } }]).then(() => 'saved?!', (e) => e);
    const missingNote = await t.save([{ type: 'insert', values: { note: 'no user' } }]).then(() => 'saved?!', (e) => e);
    return [
      `user_id → ${fk.table.name}.${fk.column}`,
      `search "GIFT" → ${found.rows[0][2]}`,
      `bad FK → ${api.explainError(err).message}`,
      `missing required → ${api.explainError(missingNote).message}`,
    ];
  });

  await check('Foreign keys (Postgres, read-only)', async () => {
    const c = conns.find((x) => x.name === 'ipo-postgres');
    if (!c) return 'skipped (ipo-postgres not running)';
    const d = await api.manager.get(c.id);
    const meta = await d.openTable({ database: d.defaultDatabase, schema: 'public', name: 'auth_group_permissions', type: 'table' }).meta();
    const refs = meta.columns.filter((col) => col.references).map((col) => `${col.name} → ${col.references.table.name}.${col.references.column}`);
    if (!refs.length) throw new Error('no FKs found');
    return refs;
  });

  const setSafety = async (name, safety) => {
    const c = conns.find((x) => x.name === name);
    await api.manager.disconnect(c.id);
    await api.store.update(c.id, { safety });
    return api.store.get(c.id);
  };
  const runInEditor = async (connName, db, text) => {
    const c = conns.find((x) => x.name === connName);
    const mark = api.trace.length;
    await api.runner.newQuery(c.id, db, text);
    vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('dockdb.runQuery');
    return (await waitTrace(api, (t, i) => i >= mark && t.startsWith('results:send:results'), 20000, 'results')).replace('results:send:results ', '');
  };

  await check('Read-only: write queries are blocked before reaching the database', async () => {
    await setSafety('dockdb-test-mysql', 'readonly');
    await setSafety('dockdb-test-mongo', 'readonly');
    const d = await api.manager.get(conns.find((x) => x.name === 'dockdb-test-mysql').id);
    const before = (await d.query('shop', 'SELECT COUNT(*) FROM logs')).rows[0][0];
    const sqlResult = await runInEditor('dockdb-test-mysql', 'shop', 'DELETE FROM logs');
    const after = (await d.query('shop', 'SELECT COUNT(*) FROM logs')).rows[0][0];
    const readResult = await runInEditor('dockdb-test-mysql', 'shop', 'SELECT COUNT(*) FROM logs');
    const m = await api.manager.get(conns.find((x) => x.name === 'dockdb-test-mongo').id);
    const mBefore = (await m.query('shop', 'db.users.countDocuments({})')).rows[0][0];
    const mongoResult = await runInEditor('dockdb-test-mongo', 'shop', 'db.users.deleteMany({})');
    const mAfter = (await m.query('shop', 'db.users.countDocuments({})')).rows[0][0];
    if (!sqlResult.startsWith('error(Not run') || before !== after) throw new Error(`MySQL not blocked: ${sqlResult} ${before}→${after}`);
    if (!mongoResult.startsWith('error(Not run') || mBefore !== mAfter) throw new Error(`Mongo not blocked: ${mongoResult} ${mBefore}→${mAfter}`);
    return [`MySQL DELETE → ${sqlResult} (logs: ${before} → ${after})`, `MySQL SELECT still runs → ${readResult}`, `Mongo deleteMany → blocked (users: ${mBefore} → ${mAfter})`];
  });

  await check('Read-only: the server session refuses writes too (defense in depth)', async () => {
    const out = [];
    const my = await api.manager.get(conns.find((x) => x.name === 'dockdb-test-mysql').id);
    out.push(`MySQL: ${await my.query('shop', "INSERT INTO logs VALUES ('x', 1)").then(() => 'WROTE!', (e) => e.message)}`);
    const pgConn = conns.find((x) => x.name === 'dockdb-test-postgres');
    if (pgConn) {
      await setSafety('dockdb-test-postgres', 'readonly');
      const pg = await api.manager.get(pgConn.id);
      out.push(`Postgres: ${await pg.query('shop', 'CREATE TABLE should_fail (a int)').then(() => 'WROTE!', (e) => e.message)}`);
      out.push(`Postgres SELECT: ${(await pg.query('shop', 'SELECT count(*) FROM items')).rows[0][0]} rows`);
      await setSafety('dockdb-test-postgres', 'dev');
      const pgDev = await api.manager.get(pgConn.id);
      await pgDev.query('shop', 'CREATE TABLE IF NOT EXISTS dev_can_write (a int)');
      await pgDev.query('shop', 'DROP TABLE dev_can_write');
      out.push('Postgres back to Dev: CREATE/DROP works');
    }
    if (out.some((o) => o.includes('WROTE!'))) throw new Error(out.join(' | '));
    return out;
  });

  await check('Restore Dev mode', async () => {
    await setSafety('dockdb-test-mysql', 'dev');
    await setSafety('dockdb-test-mongo', 'dev');
    return 'ok';
  });

  await check('No JavaScript errors in webviews', async () => {
    const errs = api.trace.filter((t) => t.includes('client-error'));
    if (errs.length) throw new Error(errs.join(' | '));
    return `${api.trace.length} events`;
  });

  fs.writeFileSync(process.env.DOCKDB_REPORT, JSON.stringify({ results, trace: api.trace }, null, 2));
  if (results.some((r) => !r.ok)) throw new Error(`${results.filter((r) => !r.ok).length} checks failed`);
};
