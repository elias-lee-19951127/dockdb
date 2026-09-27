import { cluster, Cluster, fingerprint, PlanSummary, readableSql } from '../src/timeline/analyze';
import type { FromTimeline, TimelineQuery, ToTimeline } from '../src/timeline/protocol';

declare function acquireVsCodeApi(): { postMessage(m: FromTimeline): void };
const vscode = acquireVsCodeApi();
const post = (m: FromTimeline) => vscode.postMessage(m);
window.addEventListener('error', (e) => post({ type: 'client-error', message: `${e.message} @${e.lineno}` }));

type ExplainState = { loading: true } | { summary: PlanSummary } | { error: string };

const S = {
  state: { type: 'state', candidates: [] } as Extract<ToTimeline, { type: 'state' }>,
  queries: [] as TimelineQuery[],
  selected: undefined as number | undefined,
  explains: new Map<number, ExplainState>(),
  filter: '',
  pick: '' as string,
};

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
const ms = (n: number) => (n >= 100 ? `${Math.round(n)} ms` : n >= 1 ? `${n.toFixed(1)} ms` : `${n.toFixed(2)} ms`);
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();
/** Line breaks before the main clauses, so ORM one-liners become readable. */
const pretty = (sql: string) =>
  oneLine(sql).replace(/\s+(FROM|WHERE|INNER JOIN|LEFT JOIN|RIGHT JOIN|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|RETURNING|VALUES|SET|ON CONFLICT)\b/gi, '\n$1');

document.body.innerHTML = `
  <header id="bar"></header>
  <div id="banner" hidden></div>
  <main>
    <section id="list" tabindex="0"></section>
    <aside id="detail" hidden></aside>
  </main>`;
const $ = (id: string) => document.getElementById(id)!;

window.addEventListener('message', (e: MessageEvent<ToTimeline>) => {
  const m = e.data;
  switch (m.type) {
    case 'state':
      S.state = m;
      if (!S.pick || !m.candidates.some((c) => c.id === S.pick)) S.pick = m.candidates[0]?.id ?? '';
      renderBar();
      renderBanner();
      renderList();
      break;
    case 'queries':
      if (m.reset) {
        S.queries = [];
        S.selected = undefined;
        S.explains.clear();
      }
      S.queries.push(...m.queries);
      if (S.queries.length > 1000) S.queries.splice(0, S.queries.length - 1000);
      renderList();
      renderDetail();
      break;
    case 'explain':
      S.explains.set(m.id, m.summary ? { summary: m.summary } : { error: m.error ?? 'Explain failed' });
      renderDetail();
      break;
  }
});

// ───────────────────────── toolbar ─────────────────────────

function renderBar() {
  const rec = S.state.recording;
  const bar = $('bar');
  if (rec) {
    bar.innerHTML = `
      <span class="rec"><i class="dot"></i>Recording <b>${esc(rec.name)}</b> <span class="muted">since ${time(rec.since).slice(0, 8)}</span></span>
      <button id="stop">■ Stop</button>
      <span class="sep"></span>
      ${filterAndClear()}`;
    $('stop').onclick = () => post({ type: 'stop' });
  } else if (S.state.candidates.length) {
    bar.innerHTML = `
      <select id="conn" title="Postgres containers in Dev mode">${S.state.candidates.map((c) => `<option value="${esc(c.id)}" ${c.id === S.pick ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <button id="start" class="primary">● Record queries</button>
      <span class="sep"></span>
      ${filterAndClear()}`;
    ($('conn') as HTMLSelectElement).onchange = (e) => (S.pick = (e.target as HTMLSelectElement).value);
    $('start').onclick = () => S.pick && post({ type: 'start', connId: S.pick });
  } else {
    bar.innerHTML = `<span class="muted">No Postgres container in Dev mode yet — the timeline reads a Postgres container's logs. Start one, then rescan in the Databases view.</span>${S.queries.length ? `<span class="sep"></span>${filterAndClear()}` : ''}`;
  }
  const f = document.getElementById('filter') as HTMLInputElement | null;
  if (f) {
    f.value = S.filter;
    f.oninput = () => {
      S.filter = f.value.trim().toLowerCase();
      renderList();
    };
  }
  const clear = document.getElementById('clear');
  if (clear) clear.onclick = () => post({ type: 'clear' });
}

const filterAndClear = () => `
  <input id="filter" type="search" placeholder="Filter by table or SQL…" spellcheck="false">
  <button id="clear" class="ghost" title="Clear the timeline">Clear</button>`;

function renderBanner() {
  const b = $('banner');
  b.hidden = !S.state.error;
  b.textContent = S.state.error ?? '';
}

// ───────────────────────── list ─────────────────────────

function visible(): TimelineQuery[] {
  if (!S.filter) return S.queries;
  return S.queries.filter((q) => q.tables.some((t) => t.toLowerCase().includes(S.filter)) || q.sql.toLowerCase().includes(S.filter));
}

function renderList() {
  const list = $('list');
  const qs = visible();
  if (!qs.length) {
    const rec = S.state.recording;
    list.innerHTML = `<div class="empty">${
      S.queries.length
        ? 'No query matches the filter.'
        : rec
          ? `<b>Use your app now.</b><br>Every query it runs on ${esc(rec.name)} appears here, grouped by action, newest first.`
          : `<b>See the SQL your app runs.</b><br>Pick a Postgres container and press <b>● Record queries</b>, then use your app. Each click shows up as a group of queries — the slowest and repeated (N+1) ones are flagged, and <b>Explain</b> tells you why a query is slow.`
    }</div>`;
    return;
  }
  const clusters = cluster(qs).reverse();
  list.innerHTML = clusters.map(clusterHtml).join('');
  list.querySelectorAll<HTMLElement>('.q').forEach((el) => {
    el.onclick = () => select(Number(el.dataset.id));
  });
}

function clusterHtml(c: Cluster): string {
  const max = Math.max(...c.queries.map((q) => q.durationMs), 0.001);
  const apps = [...new Set(c.queries.map((q) => q.app).filter(Boolean))];
  const n1 = [...c.repeated.values()];
  return `<div class="cluster">
    <div class="ch">
      <span class="t">${time(c.start)}</span>
      <span>${c.queries.length} ${c.queries.length === 1 ? 'query' : 'queries'} · ${ms(c.totalMs)}</span>
      ${apps.length ? `<span class="muted">${esc(apps.join(', '))}</span>` : ''}
      ${n1.length ? `<span class="badge warn" title="The same query ran ${n1.join(', ')} times in one action — usually a loop that could be one query (N+1)">N+1 ×${Math.max(...n1)}</span>` : ''}
    </div>
    ${c.queries
      .map((q) => {
        const rep = c.repeated.get(fingerprint(q.sql));
        return `<div class="q ${q.id === S.selected ? 'sel' : ''}" data-id="${q.id}" title="${esc(oneLine(q.sql).slice(0, 400))}">
          <span class="dur ${q.id === c.slowest ? 'slow' : ''}"><i style="width:${Math.max(4, (q.durationMs / max) * 100)}%"></i><b>${ms(q.durationMs)}</b></span>
          <code>${esc(readableSql(q.sql))}</code>
          <span class="tags">${q.id === c.slowest ? '<span class="badge slow">slowest</span>' : ''}${rep ? `<span class="badge warn">×${rep}</span>` : ''}${q.tables.map((t) => `<span class="tbl">${esc(t)}</span>`).join('')}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

function select(id: number) {
  S.selected = id;
  $('list').querySelectorAll('.q').forEach((el) => el.classList.toggle('sel', Number((el as HTMLElement).dataset.id) === id));
  renderDetail();
}

// ───────────────────────── detail ─────────────────────────

function renderDetail() {
  const d = $('detail');
  const q = S.queries.find((x) => x.id === S.selected);
  d.hidden = !q;
  if (!q) return;
  const ex = S.explains.get(q.id);
  d.innerHTML = `
    <div class="dh">
      <span class="muted">${time(q.at)} · ${esc(q.app || 'unknown app')} · ${esc(q.database)} · ${ms(q.durationMs)}</span>
      <button class="ghost icon" id="close" title="Close">✕</button>
    </div>
    <pre class="sql" title="Simplified for reading — Copy SQL and Open in editor use the exact statement">${esc(pretty(readableSql(q.sql, false)))}</pre>
    ${q.params.length ? `<div class="params">${q.params.map((p, i) => `<span><b>$${i + 1}</b> = ${p === null ? '<i>NULL</i>' : esc(`'${p}'`)}</span>`).join('')}</div>` : ''}
    <div class="actions">
      <button id="explain" class="primary" ${ex && 'loading' in ex ? 'disabled' : ''}>${ex && 'loading' in ex ? 'Explaining…' : 'Explain'}</button>
      <button id="open-sql">Open in editor</button>
      <button id="copy" class="ghost">Copy SQL</button>
      ${q.tables.map((t) => `<button class="tbl-btn" data-table="${esc(t)}" title="Open ${esc(t)}">⊞ ${esc(t)}</button>`).join('')}
    </div>
    <div id="explain-out">${ex ? explainHtml(ex) : ''}</div>`;
  $('close').onclick = () => {
    S.selected = undefined;
    renderList();
    renderDetail();
  };
  $('explain').onclick = () => {
    S.explains.set(q.id, { loading: true });
    renderDetail();
    post({ type: 'explain', id: q.id });
  };
  $('open-sql').onclick = () => post({ type: 'open-sql', id: q.id });
  $('copy').onclick = () => post({ type: 'copy', text: q.sql });
  d.querySelectorAll<HTMLElement>('.tbl-btn').forEach((b) => (b.onclick = () => post({ type: 'open-table', id: q.id, table: b.dataset.table! })));
  d.querySelectorAll<HTMLElement>('[data-copy]').forEach((b) => (b.onclick = () => post({ type: 'copy', text: b.dataset.copy! })));
}

function explainHtml(ex: ExplainState): string {
  if ('loading' in ex) return '<div class="muted">Asking Postgres for the plan…</div>';
  if ('error' in ex) return `<div class="err">${esc(ex.error)}</div>`;
  const s = ex.summary;
  return `
    <p class="headline">${esc(s.headline)}</p>
    <p class="muted small">${s.analyzed ? `Ran it in a read-only transaction that was rolled back · ${ms(s.totalMs ?? 0)}` : 'Planned only (not run): this statement changes data, or its parameter values were not logged — numbers are estimates.'}</p>
    <div class="steps">${s.steps
      .map(
        (st) => `<div class="step ${st.hot ? 'hot' : ''}" style="padding-left:${st.depth * 14 + 6}px">
          <span class="bar"><i style="width:${st.pct}%"></i></span>
          <span class="pct">${st.pct}%</span>
          <b>${esc(st.label)}</b>${st.relation ? ` <span class="tbl">${esc(st.relation)}</span>` : ''}
          ${st.detail ? `<code>${esc(st.detail)}</code>` : ''}
          <span class="muted">${st.rows !== undefined ? `${st.rows.toLocaleString('en-US')} rows` : ''}${st.rowsRemoved ? ` · ${st.rowsRemoved.toLocaleString('en-US')} filtered out` : ''}</span>
        </div>`,
      )
      .join('')}</div>
    ${
      s.suggestion
        ? `<div class="suggest"><b>Try an index</b><p>${esc(s.suggestion.why)}</p>
           <div class="code"><code>${esc(s.suggestion.sql)}</code><button class="ghost" data-copy="${esc(s.suggestion.sql)}">Copy</button></div>
           <p class="muted small">Add it through your ORM's migration so every environment gets it — running it here only changes this container.</p></div>`
        : ''
    }`;
}

renderBar();
renderList();
post({ type: 'ready' });
