'use strict';

// ---------------------------------------------------------------------------
// Insights: the takeaways cards and the chat thread. Everything is scoped
// server-side to the signed-in member's organization; this page only draws
// what /api/insights/* returns. The transcript lives here, in memory, and is
// sent whole with each question -- the server keeps no conversation state.
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/login?next=%2Finsights'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

function timeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Markdown, the small safe subset the model is asked to write: paragraphs,
// headings, bullet and numbered lists, pipe tables, fenced code, and inline
// bold / italic / code. Built as DOM nodes from text, never innerHTML, so a
// session title that contains markup comes out as the characters it is.
// ---------------------------------------------------------------------------
function inline(text) {
  const frag = document.createDocumentFragment();
  // code first so markers inside backticks are left alone
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) frag.append(el('code', { text: tok.slice(1, -1) }));
    else if (m[2]) frag.append(el('strong', { text: tok.slice(2, -2) }));
    else frag.append(el('em', { text: tok.slice(1, -1) }));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
function isTableRule(line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line); }
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function markdown(text) {
  const root = document.createDocumentFragment();
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let i = 0;
  const para = [];
  const flush = () => {
    if (!para.length) return;
    root.append(el('p', null, inline(para.join(' '))));
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      root.append(el('pre', null, el('code', { text: buf.join('\n') })));
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); root.append(el('h' + h[1].length, null, inline(h[2]))); i++; continue; }
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
      root.append(el('table', null,
        el('thead', null, el('tr', null, ...head.map((c) => el('th', null, inline(c))))),
        el('tbody', null, ...rows.map((r) => el('tr', null,
          ...r.map((c) => el('td', null, inline(c))))))));
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const list = el(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        const item = el('li', null, inline(m[2]));
        i++;
        // continuation lines indented under the bullet
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) &&
               !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          item.append(' ', inline(lines[i].trim()));
          i++;
        }
        list.append(item);
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return root;
}

// ---------------------------------------------------------------------------
// The queries behind an answer. Shown collapsed under every answer and under
// the takeaways: a number you can trace to a query is one you can check.
// ---------------------------------------------------------------------------
function stepsNode(steps) {
  const shown = (steps || []).filter((s) => s.sql || s.table || /describe/.test(s.tool || ''));
  if (!shown.length) return null;
  const body = el('div', { class: 'stepsbody' });
  shown.forEach((s, idx) => {
    const head = el('div', { class: 'stephead' },
      el('span', { text: `${idx + 1}.` }),
      el('span', { text: s.sql ? 'query' : `describe ${s.table || 'all tables'}` }),
      el('span', { class: 'spacer' }),
      s.error ? el('span', { class: 'steperr', text: 'failed: ' + s.error })
              : (s.rows != null ? el('span', { text: `${s.rows} row${s.rows === 1 ? '' : 's'}` }) : null));
    body.append(el('div', { class: 'step' }, head,
      s.sql ? el('pre', { text: s.sql }) : null));
  });
  return el('details', { class: 'steps' },
    el('summary', { text: `${shown.length} quer${shown.length === 1 ? 'y' : 'ies'} behind this answer` }),
    body);
}

// ---------------------------------------------------------------------------
// Takeaways
// ---------------------------------------------------------------------------
const take = { timer: null };

function renderTakeaways(d) {
  const meta = $('#takeMeta');
  const err = $('#takeErr');
  err.hidden = true;
  const lists = {};
  for (const col of document.querySelectorAll('.takecol')) lists[col.dataset.kind] = col.querySelector('.takelist');

  if (d.status === 'pending') {
    meta.textContent = 'analysing the last 30 days, usually one to three minutes';
    for (const l of Object.values(lists)) {
      l.replaceChildren(el('div', { class: 'take skel skel-take' }), el('div', { class: 'take skel skel-take' }));
    }
    $('#takeSummary').textContent = '';
    $('#takeSteps').hidden = true;
    return;
  }
  if (d.status === 'error') {
    meta.textContent = d.refreshing ? 'trying again' : `last attempt ${timeShort(d.generatedAt)}`;
    err.textContent = d.error;
    err.hidden = false;
    for (const l of Object.values(lists)) l.replaceChildren();
    $('#takeSummary').textContent = '';
    return;
  }
  meta.textContent = `generated ${timeShort(d.generatedAt)}` +
    (d.seconds ? ` in ${d.seconds}s` : '') + (d.refreshing ? ' · regenerating' : '');
  $('#takeSummary').textContent = d.data.summary || '';
  for (const [kind, list] of Object.entries(lists)) {
    const items = (d.data.highlights || []).filter((h) => h.kind === kind);
    if (!items.length) {
      list.replaceChildren(el('div', { class: 'empty', text: 'Nothing the data supported.' }));
      continue;
    }
    list.replaceChildren(...items.map((h) => el('article', { class: 'take' },
      el('h4', { text: h.title }),
      el('p', { text: h.detail }),
      h.evidence ? el('p', { class: 'evidence', text: h.evidence }) : null,
      h.who && h.who.length
        ? el('div', { class: 'who' }, ...h.who.map((w) => el('span', { text: w, title: w })))
        : null)));
  }
  const steps = stepsNode(d.steps);
  const det = $('#takeSteps');
  if (steps) {
    det.querySelector('.stepsbody').replaceWith(steps.querySelector('.stepsbody'));
    det.hidden = false;
  } else {
    det.hidden = true;
  }
}

async function loadTakeaways(fresh) {
  clearTimeout(take.timer);
  try {
    const d = await api('/api/insights/takeaways' + (fresh ? '?fresh=1' : ''));
    renderTakeaways(d);
    $('#takeRefresh').disabled = !!d.refreshing;
    // a run is in flight: poll until it lands. 10s is well under the
    // minutes a run takes and well over what the server minds answering.
    if (d.refreshing || d.status === 'pending') take.timer = setTimeout(() => loadTakeaways(false), 10000);
  } catch (e) {
    if (e.message === 'signed out') return;
    const err = $('#takeErr');
    err.textContent = e.message;
    err.hidden = false;
    $('#takeMeta').textContent = '';
    $('#takeRefresh').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
const chat = { messages: [], busy: false };

function addUser(text) {
  $('#thread').append(el('div', { class: 'msg user', text }));
}

function addAssistant(answer, steps, pending) {
  const body = el('div', { class: 'body' });
  if (pending) body.textContent = 'Querying';
  else body.append(markdown(answer));
  const node = el('div', { class: 'msg assistant' + (pending ? ' pending' : '') }, body, stepsNode(steps));
  $('#thread').append(node);
  return node;
}

function setBusy(on) {
  chat.busy = on;
  $('#askSend').disabled = on;
  $('#askInput').disabled = on;
}

async function ask(text) {
  text = (text || '').trim();
  if (!text || chat.busy) return;
  $('#chatErr').hidden = true;
  $('#suggest').hidden = true;
  $('#chatClear').hidden = false;
  addUser(text);
  chat.messages.push({ role: 'user', content: text });
  $('#askInput').value = '';
  const placeholder = addAssistant('', null, true);
  placeholder.scrollIntoView({ block: 'nearest' });
  setBusy(true);
  try {
    const d = await api('/api/insights/chat', { messages: chat.messages });
    placeholder.remove();
    addAssistant(d.answer || '(no answer)', d.steps, false).scrollIntoView({ block: 'nearest' });
    chat.messages.push({ role: 'assistant', content: d.answer || '' });
  } catch (e) {
    placeholder.remove();
    // the question stays in the transcript so it can be sent again
    chat.messages.pop();
    $('#thread').lastElementChild?.remove();
    $('#askInput').value = text;
    if (e.message !== 'signed out') {
      $('#chatErr').textContent = e.message;
      $('#chatErr').hidden = false;
    }
  } finally {
    setBusy(false);
    $('#askInput').focus();
  }
}

function wireChat() {
  $('#askForm').addEventListener('submit', (e) => { e.preventDefault(); ask($('#askInput').value); });
  // Enter sends, Shift+Enter makes a new line: the box is a question, not an essay
  $('#askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#askInput').value); }
  });
  for (const b of document.querySelectorAll('#suggest button')) {
    b.addEventListener('click', () => ask(b.textContent));
  }
  $('#chatClear').addEventListener('click', () => {
    chat.messages = [];
    $('#thread').replaceChildren();
    $('#suggest').hidden = false;
    $('#chatClear').hidden = true;
    $('#chatErr').hidden = true;
    $('#askInput').focus();
  });
}

// ---------------------------------------------------------------------------
async function init() {
  let status;
  try {
    status = await api('/api/insights/status');
  } catch (e) {
    if (e.message === 'signed out') return;
    $('#offCard').hidden = false;
    $('#offReason').textContent = e.message;
    return;
  }
  if (status.viewer && window.setViewer) window.setViewer(status.viewer.email, status.viewer.org);
  if (!status.enabled) {
    $('#offCard').hidden = false;
    $('#offReason').textContent = status.reason ? `Reason: ${status.reason}.` : '';
    return;
  }
  $('#onPages').hidden = false;
  wireChat();
  $('#takeRefresh').addEventListener('click', () => { $('#takeRefresh').disabled = true; loadTakeaways(true); });
  loadTakeaways(false);
}

init();
