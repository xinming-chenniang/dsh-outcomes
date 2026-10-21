/**
 * 管理页（**请求期渲染**，自包含：没有构建步骤、没有外部资源）。
 *
 * 为什么不做成"页面是生成物"（个人控制台版是那样）：那种模型要求"登记完再跑一次构建"，
 * 于是就有注入点、有"忘了重建"、有脆弱的 HTML 断言。这里每次请求现算一遍 —— 本地小文件，代价可忽略。
 *
 * 安全：所有插进 DOM 的数据都走 textContent / 属性赋值，不用 innerHTML 拼数据；
 * 预览用宿主加的 CSP `sandbox` 隔离（见 lib/index.js 的 SANDBOX_CSP）。
 *
 * 模板里用 `__TOKEN__` 占位而不是 `${}`：免得"服务端模板字符串"和"页内 JS 的模板字符串"互相打架。
 */
import { kindLabel } from './kind.js'

const STYLE = `
:root { color-scheme: light dark; --fg:#1c2126; --muted:#6b7480; --line:#e0e4ea; --bg:#fff; --bg2:#f6f8fa; --accent:#2f6fed; --warn:#b4690e; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6e9ee; --muted:#98a1ad; --line:#2c3138; --bg:#15181c; --bg2:#1c2026; --accent:#6f9bff; --warn:#e0a458; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.55 -apple-system,"Segoe UI",Roboto,"Helvetica Neue","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); }
header { padding:18px 22px 12px; border-bottom:1px solid var(--line); }
h1 { margin:0 0 4px; font-size:17px; font-weight:650; }
.sub { color:var(--muted); font-size:12.5px; }
.sub code { background:var(--bg2); padding:1px 5px; border-radius:4px; }
main { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1.1fr); gap:0; height:calc(100vh - 94px); }
.left { border-right:1px solid var(--line); display:flex; flex-direction:column; min-height:0; }
.right { display:flex; flex-direction:column; min-height:0; background:var(--bg2); }
.bar { display:flex; gap:8px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
input[type=search], select { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 9px; }
input[type=search] { flex:1 1 180px; min-width:120px; }
button { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 11px; cursor:pointer; }
button:hover { border-color:var(--accent); }
button[disabled] { opacity:.5; cursor:default; }
button.seg-on { border-color:var(--accent); color:var(--accent); }
.list { overflow:auto; padding:4px 0; min-height:0; }
.row { padding:9px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
.row:hover { background:var(--bg2); }
.row.sel { background:var(--bg2); box-shadow: inset 3px 0 0 var(--accent); }
.row .t { font-weight:600; }
.row .meta { color:var(--muted); font-size:12px; margin-top:2px; }
.tag { display:inline-block; font-size:11px; border:1px solid var(--line); border-radius:999px; padding:0 7px; margin-right:6px; color:var(--muted); }
.tag.gone { color:var(--warn); border-color:var(--warn); }
.detail { padding:14px 18px; overflow:auto; min-height:0; }
.detail h2 { font-size:15px; margin:0 0 6px; }
.kv { font-size:12.5px; color:var(--muted); margin:2px 0 10px; }
.kv b { color:var(--fg); font-weight:600; }
.paths { list-style:none; padding:0; margin:0 0 12px; }
.paths li { font-size:12.5px; padding:4px 0; border-bottom:1px dashed var(--line); display:flex; gap:8px; align-items:center; }
.paths code { flex:1; overflow-wrap:anywhere; }
.preview { border:1px solid var(--line); border-radius:10px; background:var(--bg); min-height:220px; overflow:hidden; }
.preview iframe { width:100%; height:52vh; border:0; background:#fff; }
.preview img { max-width:100%; display:block; }
.actions { display:flex; gap:8px; margin:12px 0 0; flex-wrap:wrap; }
.note { font-size:12.5px; color:var(--muted); margin-top:10px; white-space:pre-wrap; }
.banner { margin:10px 14px 0; padding:8px 11px; border:1px solid var(--warn); color:var(--warn); border-radius:8px; font-size:12.5px; display:none; }
.empty { padding:22px 16px; color:var(--muted); font-size:13px; }
footer { padding:8px 14px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); display:flex; gap:10px; flex-wrap:wrap; }
`

const SCRIPT = `
var PREFIX = '__PREFIX__', GUARD = '__GUARD__', PAGE_SIZE = __PAGESIZE__;
var T = __DICT__;
var state = { rows: [], deleted: [], sel: null, mode: 'active', q: '', kind: '' };

function t(key) { return (T[key] !== undefined ? T[key] : key); }
function el(tag, props, kids) {
  var node = document.createElement(tag);
  if (props) for (var k in props) {
    if (k === 'text') node.textContent = props[k];
    else if (k === 'class') node.className = props[k];
    else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), props[k]);
    else node.setAttribute(k, props[k]);
  }
  (kids || []).forEach(function (kid) { if (kid) node.appendChild(kid); });
  return node;
}
function api(path, opts) {
  return fetch(PREFIX + path, opts).then(function (res) {
    return res.json().then(function (body) { return { status: res.status, body: body }; });
  });
}
function post(path, payload) {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-outcomes': GUARD }, body: JSON.stringify(payload) });
}
function fmt(iso) { return String(iso || '').slice(0, 16).replace('T', ' '); }

/**
 * 拉数据。q 非空时**重新查服务端**（而不是只在本地已拉到的窗口里过滤）——
 * 否则清单超过一屏窗口（pageSize）时，搜索会「搜不到明明存在的条目」，
 * 那种错很难被发现。窗口大小由服务端 config 的 pageSize 决定。
 */
function load(q) {
  var url = '/api/list?state=all&limit=' + PAGE_SIZE + (q ? '&q=' + encodeURIComponent(q) : '');
  return api(url).then(function (res) {
    if (res.body && res.body.ok) {
      state.rows = res.body.rows.filter(function (r) { return !r.removedAt; });
      state.deleted = res.body.rows.filter(function (r) { return r.removedAt; });
      state.full = res.body.rows.length >= PAGE_SIZE;
      paintBanner(state.rows.filter(function (r) { return r.missing && r.missing.length; }).length);
    }
    if (window.__seg) window.__seg();
    render();
  });
}
var searchTimer = null;
function onSearch(value) {
  state.q = value;
  render();
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(function () { load(state.q); }, 250);
}
function paintBanner(count) {
  var node = document.getElementById('banner');
  if (count > 0) { node.style.display = 'block'; node.textContent = t('banner.gone').replace('{n}', count); }
  else node.style.display = 'none';
}
function visible() {
  var base = state.mode === 'deleted' ? state.deleted : state.rows;
  var q = state.q.trim().toLowerCase();
  return base.filter(function (row) {
    if (state.kind && row.kind !== state.kind) return false;
    if (!q) return true;
    var hay = [row.title, row.by, row.note, row.id, row.kind].concat(row.paths || []).join(' ').toLowerCase();
    return q.split(/\\s+/).every(function (term) { return hay.indexOf(term) !== -1; });
  });
}
function render() {
  var list = document.getElementById('list');
  list.textContent = '';
  var rows = visible();
  document.getElementById('count').textContent = t('count').replace('{n}', rows.length).replace('{all}', state.rows.length)
    + (state.full ? '　·　' + t('count.window').replace('{n}', String(PAGE_SIZE)) : '');
  if (rows.length === 0) { list.appendChild(el('div', { class: 'empty', text: state.rows.length ? t('empty.filtered') : t('empty.none') })); }
  rows.forEach(function (row) {
    var meta = el('div', { class: 'meta' }, [
      el('span', { class: 'tag', text: row.kind }),
      el('span', { text: fmt(row.at) + (row.by ? ' · ' + row.by : '') }),
      (row.missing && row.missing.length) ? el('span', { class: 'tag gone', text: t('tag.gone') }) : null,
      row.removedAt ? el('span', { class: 'tag', text: t('tag.removed') }) : null
    ]);
    list.appendChild(el('div', {
      class: 'row' + (state.sel === row.id ? ' sel' : ''),
      onclick: function () { state.sel = row.id; render(); detail(row); },
    }, [el('div', { class: 't', text: row.title }), meta]));
  });
  if (!state.sel && rows.length) { state.sel = rows[0].id; detail(rows[0]); }
}
function detail(row) {
  var box = document.getElementById('detail');
  box.textContent = '';
  box.appendChild(el('h2', { text: row.title }));
  box.appendChild(el('div', { class: 'kv' }, [
    el('span', { text: row.id + '  ·  ' + row.kind + '  ·  ' }), el('b', { text: fmt(row.at) }),
    row.by ? el('span', { text: '  ·  ' + row.by }) : null,
    row.sessionId ? el('span', { text: '  ·  ' + row.sessionId }) : null
  ]));

  var paths = el('ul', { class: 'paths' });
  (row.paths || []).forEach(function (file, i) {
    var gone = (row.missing || []).indexOf(file) !== -1;
    paths.appendChild(el('li', {}, [
      el('code', { text: file }),
      gone ? el('span', { class: 'tag gone', text: t('tag.gone') }) : el('a', { href: PREFIX + '/file/' + encodeURIComponent(row.id) + '/' + i, target: '_blank', text: t('open') })
    ]));
  });
  box.appendChild(paths);

  if (row.note) box.appendChild(el('div', { class: 'note', text: row.note }));

  var preview = el('div', { class: 'preview' });
  var first = (row.paths || [])[0];
  var gone = first && (row.missing || []).indexOf(first) !== -1;
  if (!first || gone) preview.appendChild(el('div', { class: 'empty', text: t('preview.unavailable') }));
  else {
    var src = PREFIX + '/file/' + encodeURIComponent(row.id) + '/0';
    if (row.kind === 'html' || row.kind === 'pdf') preview.appendChild(el('iframe', { src: src, sandbox: 'allow-scripts allow-popups allow-forms allow-modals' }));
    else if (row.kind === 'img') preview.appendChild(el('img', { src: src, alt: row.title }));
    else preview.appendChild(el('div', { class: 'empty' }, [el('a', { href: src, text: t('download') })]));
  }
  box.appendChild(preview);

  var actions = el('div', { class: 'actions' });
  if (row.removedAt) {
    actions.appendChild(el('button', { text: t('act.restore'), onclick: function () { post('/api/restore', { id: row.id }).then(load); } }));
  } else {
    actions.appendChild(el('button', {
      text: t('act.remove'),
      onclick: function () {
        var why = window.prompt(t('prompt.why'), '');
        if (why === null) return;
        post('/api/remove', { id: row.id, why: why }).then(load);
      },
    }));
  }
  actions.appendChild(el('button', { text: t('act.copy'), onclick: function () { navigator.clipboard.writeText((row.paths || []).join('\\n')); } }));
  box.appendChild(actions);
}
function boot() {
  document.getElementById('q').addEventListener('input', function (e) { onSearch(e.target.value); });
  document.getElementById('kind').addEventListener('change', function (e) { state.kind = e.target.value; render(); });
  document.getElementById('mode-active').addEventListener('click', function () { state.mode = 'active'; state.sel = null; seg(); render(); });
  document.getElementById('mode-deleted').addEventListener('click', function () { state.mode = 'deleted'; state.sel = null; seg(); render(); });
  document.getElementById('refresh').addEventListener('click', load);
  function seg() {
    document.getElementById('mode-active').className = state.mode === 'active' ? 'seg-on' : '';
    document.getElementById('mode-deleted').className = state.mode === 'deleted' ? 'seg-on' : '';
    document.getElementById('mode-deleted').textContent = t('mode.deleted').replace('{n}', state.deleted.length);
  }
  window.__seg = seg;
  document.getElementById('q').placeholder = t('search.placeholder');
  seg();
  load();
}
document.addEventListener('DOMContentLoaded', boot);
`

const DICT = {
  en: {
    'title': 'DSH outcomes',
    'search.placeholder': 'Search title / source / note / path…',
    'mode.active': 'Active',
    'mode.deleted': 'Removed ({n})',
    'act.refresh': 'Refresh',
    'act.remove': 'Unregister',
    'act.restore': 'Put back',
    'act.copy': 'Copy paths',
    'prompt.why': 'Why unregister it? (the file itself is not touched)',
    'open': 'open',
    'download': 'download',
    'count': '{n} of {all} shown',
    'count.window': 'window is full ({n}) — type to search the whole registry',
    'empty.none': 'Nothing registered yet. Ask your agent to register a deliverable, or run: dsh-outcomes add --title "…" --paths "…"',
    'empty.filtered': 'No row matches the filter.',
    'tag.gone': 'file missing',
    'tag.removed': 'unregistered',
    'preview.unavailable': 'Nothing to preview (no file, or the file is gone).',
    'banner.gone': '{n} registered file(s) are no longer on disk — the rows stay, use "Copy paths" to hunt them down.',
    'kind.all': 'all types',
    'foot.hint': 'Registering records paths only — files are never moved, copied or uploaded.',
    'lang.other': '中文',
  },
  zh: {
    'title': 'DSH 成果清单',
    'search.placeholder': '搜索标题 / 来源 / 备注 / 路径…',
    'mode.active': '在用',
    'mode.deleted': '已删除（{n}）',
    'act.refresh': '刷新',
    'act.remove': '取消登记',
    'act.restore': '放回清单',
    'act.copy': '复制路径',
    'prompt.why': '为什么取消登记？（文件本身不动）',
    'open': '打开',
    'download': '下载',
    'count': '显示 {n} / {all} 条',
    'count.window': '窗口已满（{n} 条）—— 输入关键词可搜整份清单',
    'empty.none': '还没有登记任何成果。让 agent 登记，或跑：dsh-outcomes add --title "…" --paths "…"',
    'empty.filtered': '没有匹配的行。',
    'tag.gone': '文件不在了',
    'tag.removed': '已取消登记',
    'preview.unavailable': '没有可预览的内容（没有文件，或文件已不在）。',
    'banner.gone': '有 {n} 个登记的文件已经不在磁盘上 —— 登记保留着，可用「复制路径」去找。',
    'kind.all': '全部类型',
    'foot.hint': '登记只记路径 —— 文件不会被移动、复制或上传。',
    'lang.other': 'English',
  },
}

/** 生成整页 HTML。参数都来自 `lib/index.js`（每次请求现算）。`lang` ∈ en | zh。 */
export function renderPage({ version, dir, registry, deletedFile, guardHeader, prefix, pageSize = 200, lang = 'en' }) {
  const useZh = lang === 'zh'
  const L = useZh ? DICT.zh : DICT.en
  const dict = JSON.stringify(L)
  const otherLang = useZh ? 'en' : 'zh'
  const kinds = ['html', 'pdf', 'img', 'doc', 'data', 'text', 'other']
  const options = kinds
    .map((kind) => `        <option value="${kind}">${kindLabel(kind, useZh ? 'zh' : 'en')}</option>`)
    .join('\n')

  return `<!doctype html>
<html lang="${useZh ? 'zh' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L.title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${L.title} <span class="sub">v${version}</span>
    <button id="lang" style="float:right" onclick="(function(){var u=new URL(location.href);u.searchParams.set('lang','${otherLang}');location.href=u})()">${L['lang.other']}</button>
  </h1>
  <div class="sub">Registry <code>${registry}</code> · deleted log <code>${deletedFile}</code></div>
  <div class="banner" id="banner"></div>
</header>
<main>
  <section class="left">
    <div class="bar">
      <input id="q" type="search" autofocus>
      <select id="kind"><option value="">${L['kind.all']}</option>
${options}
      </select>
      <button id="mode-active" class="seg-on">${L['mode.active']}</button>
      <button id="mode-deleted">${L['mode.deleted'].replace('{n}', '0')}</button>
      <button id="refresh">${L['act.refresh']}</button>
    </div>
    <div class="sub" id="count" style="padding:8px 14px 0"></div>
    <div class="list" id="list"></div>
    <footer><span>${L['foot.hint']}</span><span style="margin-left:auto">dsh-outcomes · ${dir}</span></footer>
  </section>
  <section class="right"><div class="detail" id="detail"></div></section>
</main>
<script>
${SCRIPT.replace('__PREFIX__', prefix).replace('__GUARD__', guardHeader).replace('__DICT__', dict).replace('__PAGESIZE__', String(pageSize))}
</script>
</body>
</html>
`
}

export const PAGE_DICTIONARIES = DICT
