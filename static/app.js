'use strict';

/* 直播节目串联单前端（原生 JavaScript，无框架） */

let state = null;        // 服务端下发的完整状态
let editMode = false;    // 是否正在编辑整份清单
let editRows = [];       // 编辑中的清单工作副本
let tmpCounter = 0;      // 新增行的临时 uid

const $ = (id) => document.getElementById(id);
const KIND_LABEL = { sponsor: '赞助', interview: '访谈' };

/* ---------------- 基础工具 ---------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function isPosInt(v) {
  return Number.isInteger(v) && v > 0;
}

function fmtDur(s) {
  if (s === null || s === undefined || Number.isNaN(s)) return '-';
  const neg = s < 0;
  const abs = Math.abs(Math.round(s));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sec = abs % 60;
  const core = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
  return (neg ? '-' : '') + core;
}

function fmtTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

let toastTimer = null;
function toast(msg, isError) {
  const node = $('toast');
  node.textContent = msg;
  node.className = (isError ? 'error' : 'ok') + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = 'hidden'; }, 4000);
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.payload = data;
    throw err;
  }
  return data;
}

/* ---------------- 与服务端一致的排期算法（用于编辑预览） ---------------- */

function computePlan(rows, remaining) {
  const plan = new Map(); // uid -> 计划秒数
  let fixed = 0;
  let targetSum = 0;
  const interviews = [];
  for (const r of rows) {
    if (r.kind === 'sponsor') {
      fixed += r.fixed_seconds;
      plan.set(r.uid, r.fixed_seconds);
    } else {
      targetSum += r.target_seconds;
      plan.set(r.uid, r.target_seconds);
      interviews.push(r);
    }
  }
  const diff = remaining - fixed - targetSum;
  if (diff > 0) {
    let rest = diff;
    for (const r of interviews) {
      const add = Math.min(r.max_seconds - r.target_seconds, rest);
      plan.set(r.uid, plan.get(r.uid) + add);
      rest -= add;
      if (rest === 0) break;
    }
    if (rest > 0) return { plan, conflict: { kind: 'short', seconds: rest } };
  } else if (diff < 0) {
    let rest = -diff;
    for (const r of interviews) {
      const cut = Math.min(r.target_seconds - r.min_seconds, rest);
      plan.set(r.uid, plan.get(r.uid) - cut);
      rest -= cut;
      if (rest === 0) break;
    }
    if (rest > 0) return { plan, conflict: { kind: 'over', seconds: rest } };
  }
  return { plan, conflict: null };
}

function validateRows(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'sponsor') {
      if (!isPosInt(r.fixed_seconds)) return `第 ${i + 1} 段（赞助）的固定时长需为正整数秒`;
    } else {
      if (!isPosInt(r.target_seconds) || !isPosInt(r.min_seconds) || !isPosInt(r.max_seconds)) {
        return `第 ${i + 1} 段（访谈）的目标/最短/最长秒数需为正整数`;
      }
      if (!(r.min_seconds <= r.target_seconds && r.target_seconds <= r.max_seconds)) {
        return `第 ${i + 1} 段（访谈）需满足 最短 ≤ 目标 ≤ 最长`;
      }
    }
  }
  return null;
}

function sponsorLockError(rows) {
  if (!state || state.aired.length === 0) return null;
  const current = state.pending
    .filter((s) => s.kind === 'sponsor')
    .map((s) => [s.id, s.fixed_seconds]);
  const next = rows
    .filter((r) => r.kind === 'sponsor')
    .map((r) => [r.id, r.fixed_seconds]);
  if (next.some((r) => r[0] === null || r[0] === undefined)) {
    return '播出开始后不能再新增赞助段';
  }
  if (current.length !== next.length) return '赞助段不能删除，时长和先后顺序不能改变';
  for (let i = 0; i < current.length; i++) {
    if (current[i][0] !== next[i][0] || current[i][1] !== next[i][1]) {
      return '赞助段的时长和先后顺序不能改变';
    }
  }
  return null;
}

/* ---------------- 渲染：整体 ---------------- */

function toggle(id, hidden) {
  $(id).classList.toggle('hidden', hidden);
}

function render() {
  if (!state) return;
  const hasShow = !!state.show;
  const airedCount = state.aired.length;

  toggle('setup-section', !(!hasShow || airedCount === 0));
  toggle('status-section', !hasShow);
  toggle('current-section', !(hasShow && state.current_id !== null));
  toggle('pending-section', !hasShow);
  toggle('aired-section', !(hasShow && airedCount > 0));
  toggle('danger-section', !hasShow);

  if (!hasShow) return;

  // 设置区（播出前可修改）
  if (airedCount === 0) {
    $('setup-start').value = state.show.start_at.slice(0, 19);
    $('setup-total').value = state.show.total_seconds;
  }

  // 状态总览
  $('st-start').textContent = fmtDateTime(state.show.start_at);
  $('st-total').textContent = `${fmtDur(state.show.total_seconds)}（${state.show.total_seconds} 秒）`;
  $('st-end').textContent = fmtDateTime(state.show.end_at);
  $('st-elapsed').textContent = `${fmtDur(state.elapsed_actual)}（${state.elapsed_actual} 秒）`;
  $('st-remaining').textContent = `${fmtDur(state.remaining)}（${state.remaining} 秒）`;

  const done = state.pending.length === 0 && state.remaining === 0;
  $('st-feasible').textContent = done ? '已完成 🎉' : (state.feasible ? '正常' : '冲突');
  $('st-feasible').className = state.feasible ? 'ok-text' : 'bad-text';

  const banner = $('conflict-banner');
  if (state.conflict) {
    const c = state.conflict;
    banner.textContent = c.kind === 'short'
      ? `⚠ 冲突：按当前清单，即使所有访谈段拉到最长，仍差 ${c.seconds} 秒（${fmtDur(c.seconds)}）排不满。请编辑待播清单。`
      : `⚠ 冲突：按当前清单，即使所有访谈段压到最短，仍超出 ${c.seconds} 秒（${fmtDur(c.seconds)}）。请编辑待播清单。`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  renderCurrent();
  if (editMode) {
    toggle('pending-view', true);
    toggle('pending-edit', false);
  } else {
    toggle('pending-view', false);
    toggle('pending-edit', true);
    renderPendingView();
  }
  renderAired();
}

function renderCurrent() {
  const box = $('current-info');
  box.innerHTML = '';
  if (state.current_id === null) return;
  const seg = state.pending[0];
  const no = state.aired.length + 1;
  box.appendChild(el('div', 'current-title',
    `#${no} 「${seg.title}」 ${KIND_LABEL[seg.kind]}段`));
  const detail = seg.kind === 'sponsor'
    ? `固定时长 ${fmtDur(seg.fixed_seconds)}`
    : `计划 ${fmtDur(seg.planned_seconds)}（目标 ${seg.target_seconds}s，范围 ${seg.min_seconds}–${seg.max_seconds}s）`;
  box.appendChild(el('div', 'current-detail',
    `${detail} · 预计 ${fmtTime(seg.est_start)} → ${fmtTime(seg.est_end)}`));
}

function segParamText(s) {
  return s.kind === 'sponsor'
    ? `固定 ${s.fixed_seconds}s`
    : `目标 ${s.target_seconds}s · 最短 ${s.min_seconds}s · 最长 ${s.max_seconds}s`;
}

function renderPendingView() {
  const wrap = $('pending-view');
  wrap.innerHTML = '';
  if (state.pending.length === 0) {
    wrap.appendChild(el('p', 'hint',
      state.remaining === 0 ? '全部播出完成。' : '待播清单为空。'));
    return;
  }
  const table = el('table', 'data-table');
  const head = el('tr');
  ['#', '类型', '标题', '计划时长', '参数', '预计开始', '预计结束']
    .forEach((t) => head.appendChild(el('th', null, t)));
  table.appendChild(head);
  state.pending.forEach((s, i) => {
    const tr = el('tr', i === 0 ? 'row-current' : null);
    tr.appendChild(el('td', null, String(state.aired.length + i + 1)));
    const kindTd = el('td');
    kindTd.appendChild(el('span', `badge badge-${s.kind}`, KIND_LABEL[s.kind]));
    tr.appendChild(kindTd);
    tr.appendChild(el('td', null, s.title));
    tr.appendChild(el('td', null, `${fmtDur(s.planned_seconds)}（${s.planned_seconds}s）`));
    tr.appendChild(el('td', 'param-cell', segParamText(s)));
    tr.appendChild(el('td', null, fmtTime(s.est_start)));
    tr.appendChild(el('td', null, fmtTime(s.est_end)));
    table.appendChild(tr);
  });
  wrap.appendChild(table);
}

function renderAired() {
  const wrap = $('aired-view');
  wrap.innerHTML = '';
  const table = el('table', 'data-table');
  const head = el('tr');
  ['#', '类型', '标题', '目标/固定', '实际秒数', '记录时间']
    .forEach((t) => head.appendChild(el('th', null, t)));
  table.appendChild(head);
  state.aired.forEach((s, i) => {
    const tr = el('tr', 'row-aired');
    tr.appendChild(el('td', null, String(i + 1)));
    const kindTd = el('td');
    kindTd.appendChild(el('span', `badge badge-${s.kind}`, KIND_LABEL[s.kind]));
    tr.appendChild(kindTd);
    tr.appendChild(el('td', null, s.title));
    tr.appendChild(el('td', null,
      s.kind === 'sponsor' ? `${s.fixed_seconds}s` : `${s.target_seconds}s`));
    tr.appendChild(el('td', 'actual-cell', `${s.actual_seconds}s（${fmtDur(s.actual_seconds)}）`));
    tr.appendChild(el('td', null, fmtDateTime(s.aired_at)));
    table.appendChild(tr);
  });
  wrap.appendChild(table);
}

/* ---------------- 渲染：清单编辑器 ---------------- */

function enterEdit() {
  editRows = state.pending.map((s) => {
    const r = { uid: `id${s.id}`, id: s.id, kind: s.kind, title: s.title };
    if (s.kind === 'sponsor') {
      r.fixed_seconds = s.fixed_seconds;
    } else {
      r.target_seconds = s.target_seconds;
      r.min_seconds = s.min_seconds;
      r.max_seconds = s.max_seconds;
    }
    return r;
  });
  editMode = true;
  render();
  renderEditor();
  updatePreview();
}

function numCellInput(row, field, placeholder, locked) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = '1';
  inp.step = '1';
  inp.placeholder = placeholder || '';
  if (row[field] !== undefined && row[field] !== null && !Number.isNaN(row[field])) {
    inp.value = row[field];
  }
  if (locked) inp.readOnly = true;
  inp.addEventListener('input', () => {
    row[field] = inp.value === '' ? NaN : Number(inp.value);
    updatePreview();
  });
  return inp;
}

function renderEditor() {
  const locked = state.aired.length > 0; // 播出开始后赞助段锁定
  const wrap = $('edit-rows');
  wrap.innerHTML = '';

  const table = el('table', 'data-table edit-table');
  const head = el('tr');
  ['#', '类型', '标题', '参数（秒）', '计划', '操作'].forEach((t) => head.appendChild(el('th', null, t)));
  table.appendChild(head);

  if (editRows.length === 0) {
    const tr = el('tr');
    const td = el('td', 'hint', '清单为空，请添加分段。');
    td.colSpan = 6;
    tr.appendChild(td);
    table.appendChild(tr);
  }

  editRows.forEach((row, idx) => {
    const isSponsorLocked = locked && row.kind === 'sponsor';
    const tr = el('tr', row.kind === 'sponsor' ? 'row-sponsor' : null);

    tr.appendChild(el('td', null, String(idx + 1)));

    const kindTd = el('td');
    kindTd.appendChild(el('span', `badge badge-${row.kind}`, KIND_LABEL[row.kind]));
    tr.appendChild(kindTd);

    const titleTd = el('td');
    const titleInp = document.createElement('input');
    titleInp.type = 'text';
    titleInp.value = row.title || '';
    titleInp.placeholder = row.kind === 'sponsor' ? '赞助段' : '访谈段';
    titleInp.addEventListener('input', () => { row.title = titleInp.value; });
    titleTd.appendChild(titleInp);
    tr.appendChild(titleTd);

    const paramTd = el('td', 'param-edit');
    if (row.kind === 'sponsor') {
      paramTd.appendChild(el('span', 'param-label', '固定'));
      paramTd.appendChild(numCellInput(row, 'fixed_seconds', '秒', isSponsorLocked));
    } else {
      paramTd.appendChild(el('span', 'param-label', '目标'));
      paramTd.appendChild(numCellInput(row, 'target_seconds', '目标'));
      paramTd.appendChild(el('span', 'param-label', '最短'));
      paramTd.appendChild(numCellInput(row, 'min_seconds', '最短'));
      paramTd.appendChild(el('span', 'param-label', '最长'));
      paramTd.appendChild(numCellInput(row, 'max_seconds', '最长'));
    }
    tr.appendChild(paramTd);

    const planTd = el('td', 'planned-cell', '-');
    planTd.dataset.index = String(idx);
    tr.appendChild(planTd);

    const opsTd = el('td', 'ops-cell');
    const up = el('button', 'op-btn', '↑');
    up.title = '上移';
    up.disabled = idx === 0 || isSponsorLocked;
    up.addEventListener('click', () => moveRow(idx, -1));
    const down = el('button', 'op-btn', '↓');
    down.title = '下移';
    down.disabled = idx === editRows.length - 1 || isSponsorLocked;
    down.addEventListener('click', () => moveRow(idx, 1));
    const del = el('button', 'op-btn danger-text', '✕');
    del.title = '删除';
    del.disabled = isSponsorLocked;
    del.addEventListener('click', () => {
      editRows.splice(idx, 1);
      renderEditor();
      updatePreview();
    });
    opsTd.appendChild(up);
    opsTd.appendChild(down);
    opsTd.appendChild(del);
    tr.appendChild(opsTd);

    table.appendChild(tr);
  });

  wrap.appendChild(table);
  $('add-sponsor').disabled = locked;
}

function moveRow(idx, delta) {
  const j = idx + delta;
  if (j < 0 || j >= editRows.length) return;
  const tmp = editRows[idx];
  editRows[idx] = editRows[j];
  editRows[j] = tmp;
  renderEditor();
  updatePreview();
}

function updatePreview() {
  const preview = $('edit-preview');
  const errBox = $('edit-error');
  errBox.classList.add('hidden');

  const invalid = validateRows(editRows);
  if (invalid) {
    preview.textContent = `⚠ ${invalid}`;
    preview.className = 'hint warn';
    return;
  }
  const lockErr = sponsorLockError(editRows);
  if (lockErr) {
    preview.textContent = `⚠ ${lockErr}`;
    preview.className = 'hint warn';
    return;
  }

  const { plan, conflict } = computePlan(editRows, state.remaining);
  document.querySelectorAll('#edit-rows .planned-cell').forEach((cell) => {
    const row = editRows[Number(cell.dataset.index)];
    const p = row ? plan.get(row.uid) : null;
    cell.textContent = p === null || p === undefined ? '-' : `${fmtDur(p)}（${p}s）`;
  });

  if (!conflict) {
    preview.textContent = '✓ 恰好排满到节目终点，可以保存。';
    preview.className = 'hint ok-text';
  } else if (conflict.kind === 'short') {
    preview.textContent = `⚠ 无法排满：访谈全部拉到最长后仍差 ${conflict.seconds} 秒（${fmtDur(conflict.seconds)}），保存将被拒绝。`;
    preview.className = 'hint warn';
  } else {
    preview.textContent = `⚠ 超时：访谈全部压到最短后仍超出 ${conflict.seconds} 秒（${fmtDur(conflict.seconds)}），保存将被拒绝。`;
    preview.className = 'hint warn';
  }
}

function showEditError(msg) {
  const errBox = $('edit-error');
  errBox.textContent = `保存被拒绝：${msg}`;
  errBox.classList.remove('hidden');
}

async function saveEdit() {
  const invalid = validateRows(editRows);
  if (invalid) return showEditError(invalid);
  const lockErr = sponsorLockError(editRows);
  if (lockErr) return showEditError(lockErr);

  const payload = editRows.map((r) => {
    const item = { kind: r.kind, title: (r.title || '').trim() };
    if (r.id !== null && r.id !== undefined) item.id = r.id;
    if (r.kind === 'sponsor') {
      item.fixed_seconds = r.fixed_seconds;
    } else {
      item.target_seconds = r.target_seconds;
      item.min_seconds = r.min_seconds;
      item.max_seconds = r.max_seconds;
    }
    return item;
  });

  try {
    state = await api('/api/rundown', 'PUT', { segments: payload });
    editMode = false;
    render();
    toast('清单已保存');
  } catch (e) {
    showEditError(e.message);
  }
}

/* ---------------- 事件绑定 ---------------- */

async function refresh() {
  try {
    state = await api('/api/state');
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

function bindEvents() {
  $('setup-save').addEventListener('click', async () => {
    const startAt = $('setup-start').value;
    const total = Number($('setup-total').value);
    if (!startAt) return toast('请选择节目起点时间', true);
    if (!isPosInt(total)) return toast('总秒数需为正整数', true);
    try {
      state = await api('/api/show', 'POST', { start_at: startAt, total_seconds: total });
      render();
      toast('节目设置已保存');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('finish-btn').addEventListener('click', async () => {
    const actual = Number($('finish-actual').value);
    if (!isPosInt(actual)) return toast('请输入正整数实际秒数', true);
    const cur = state.pending[0];
    if (!window.confirm(
      `确认结束当前段「${cur.title}」，实际 ${actual} 秒？\n记录写入后不可修改。`)) return;
    try {
      state = await api('/api/finish', 'POST', { actual_seconds: actual });
      $('finish-actual').value = '';
      render();
      toast('已记录实际秒数');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('edit-toggle').addEventListener('click', enterEdit);
  $('edit-cancel').addEventListener('click', () => { editMode = false; render(); });
  $('edit-save').addEventListener('click', saveEdit);

  $('add-interview').addEventListener('click', () => {
    editRows.push({
      uid: `tmp${++tmpCounter}`, id: null, kind: 'interview', title: '',
      target_seconds: 600, min_seconds: 300, max_seconds: 900,
    });
    renderEditor();
    updatePreview();
  });

  $('add-sponsor').addEventListener('click', () => {
    editRows.push({
      uid: `tmp${++tmpCounter}`, id: null, kind: 'sponsor', title: '',
      fixed_seconds: 60,
    });
    renderEditor();
    updatePreview();
  });

  $('reset-btn').addEventListener('click', async () => {
    if (!window.confirm('确定重置节目？\n将清空节目设置与全部分段（含已播记录），不可恢复。')) return;
    try {
      state = await api('/api/reset', 'POST');
      editMode = false;
      render();
      toast('已重置');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

/* ---------------- 启动 ---------------- */

bindEvents();
refresh();
// 定时同步（编辑中不刷新，避免覆盖正在编辑的内容）
setInterval(() => { if (!editMode) refresh(); }, 5000);
// 页头时钟
setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}, 1000);
