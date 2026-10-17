'use strict';

// ---------------------------------------------------------------------------
// System: platform-wide views for the one account that is system admin.
// The server decides who that is (/system and /api/system/state both refuse
// everyone else); this page only draws the answer. Organization-level admin
// stays on /admin.
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const tbody = (sel) => document.querySelector(sel + ' tbody');

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

let state = null;

function clearPlaceholders() {
  for (const r of document.querySelectorAll('.admintable tr.placeholder')) r.remove();
}

function clearErrors() {
  for (const sel of ['#err', '#orgErr']) {
    const box = $(sel);
    box.textContent = ''; box.hidden = true;
  }
}

function showError(msg, boxSel) {
  const box = (boxSel && $(boxSel)) || $('#err');
  box.textContent = msg;
  box.hidden = !msg;
  if (msg) clearPlaceholders();
}

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  // not the system admin: the page route would have bounced, but a session
  // can lose the grant while the tab is open
  if (r.status === 403) { location.href = '/'; throw new Error('not allowed'); }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

const day = (v) => (v ? String(v).slice(0, 10) : '-');

function row(...cells) {
  return el('tr', {}, ...cells.map((c) =>
    el('td', {}, typeof c === 'string' ? document.createTextNode(c) : c)));
}

function action(label, danger, onclick) {
  return el('button',
    { class: danger ? 'linkbtn danger' : 'linkbtn', type: 'button', text: label, onclick });
}

async function act(fn, boxSel) {
  clearErrors();
  try { await fn(); await load(); } catch (e) { showError(e.message, boxSel); }
}

function renderOrgs() {
  const t = tbody('#orgs');
  t.replaceChildren();
  const mine = state.viewer.orgSlug;
  for (const o of state.orgs) {
    const controls = el('div', { class: 'rowactions' });
    if (!o.members && o.slug !== mine) {
      controls.append(action('Delete', true, () => {
        if (!confirm(`Delete '${o.slug}'? Its database is kept.`)) return;
        act(() => api('/api/admin/delete-org', { slug: o.slug }), '#orgErr');
      }));
    }
    t.append(row(
      o.name + (o.slug === mine ? ' (yours)' : ''),
      o.slug, String(o.members), day(o.created_at), controls));
  }
  $('#orgCount').textContent = `${state.orgs.length} total`;
}

function renderTotals() {
  const t = state.totals;
  $('#totOrgs').textContent = String(t.organizations);
  $('#totMembers').textContent = String(t.members);
  $('#totEmpty').textContent = String(t.empty);
}

async function load() {
  state = await api('/api/system/state');
  clearPlaceholders();
  window.setViewer(state.viewer.email, state.viewer.org);
  renderTotals();
  renderOrgs();
}

$('#orgCreate').addEventListener('click', () => act(async () => {
  const r = await api('/api/admin/create-org', {
    name: $('#newOrgName').value.trim(),
    owner_email: $('#newOrgOwner').value.trim(),
  });
  $('#newOrgName').value = ''; $('#newOrgOwner').value = '';
  $('#orgLinkOut').hidden = true;  // never show a previous org's link
  if (r.invite_link) {
    $('#orgLinkValue').value = r.invite_link;
    $('#orgLinkValue').title = 'send this to the owner; they join as the org admin';
    $('#orgLinkOut').hidden = false;
    $('#orgLinkValue').select();
  }
}, '#orgErr'));

$('#orgLinkCopy').addEventListener('click', () => {
  const f = $('#orgLinkValue');
  f.select();
  if (navigator.clipboard) navigator.clipboard.writeText(f.value);
  else document.execCommand('copy');
});

load().catch((e) => showError(e.message));
