const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  meta: { categories: [], seasons: [], counts: {}, total: 0 },
  items: [],
  itemsById: new Map(),
  category: '',
  q: '',
  editing: null, // 수정 중인 아이템
  itemImage: null, // 추가/수정 폼에서 새로 고른 사진 (Blob)
  shopImage: null,
};

// ---------- 유틸 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', json, form } = {}) {
  const opts = { method, headers: {} };
  if (json) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
  }
  const res = await fetch(path, opts);
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('로그인이 필요합니다.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

const catOf = (id) => state.meta.categories.find((c) => c.id === id) || { label: id, emoji: '📦' };

function thumbHtml(item, cls = '') {
  if (!item) return `<div class="thumb ${cls}">❔</div>`;
  const inner = item.image
    ? `<img src="/uploads/${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" />`
    : catOf(item.category).emoji;
  return `<div class="thumb ${cls}">${inner}${item.favorite ? '<span class="fav">❤️</span>' : ''}</div>`;
}

const loadingHtml = (msg) => `<div class="loading"><div class="spinner"></div>${esc(msg)}</div>`;

// 사진을 최대 1280px JPEG로 줄여서 업로드 용량과 AI 비용을 줄인다.
async function shrinkImage(file, max = 1280) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch {
    return file; // 브라우저가 디코딩하지 못하면 원본 그대로
  }
}

// ---------- 로그인 ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form input').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', json: { password: e.target.password.value } });
    e.target.reset();
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  const s = await api('/api/session');
  if (s.authRequired) showLogin();
  else toast('비밀번호가 설정되지 않아 로그아웃할 필요가 없어요.');
});

// ---------- 탭 ----------
const TITLES = { closet: '내 옷장', outfits: '코디 추천', shop: '쇼핑 도우미' };
function showView(name) {
  for (const v of ['closet', 'outfits', 'shop']) $(`#view-${v}`).hidden = v !== name;
  $$('.tabbar [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#page-title').textContent = TITLES[name];
  if (name === 'outfits') renderSavedOutfits();
  window.scrollTo(0, 0);
}
$$('.tabbar [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- 옷장 ----------
async function loadMeta() {
  state.meta = await api('/api/meta');
  $('#total-count').textContent = `${state.meta.total}벌`;
  renderChips();
}

function renderChips() {
  const { categories, counts, total } = state.meta;
  const chips = [{ id: '', label: '전체', emoji: '' }, ...categories.filter((c) => counts[c.id])];
  $('#category-chips').innerHTML = chips
    .map(
      (c) =>
        `<button class="chip ${state.category === c.id ? 'active' : ''}" data-cat="${c.id}">${c.emoji} ${esc(c.label)}<span class="n">${c.id ? counts[c.id] : total}</span></button>`,
    )
    .join('');
}

$('#category-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.category = chip.dataset.cat;
  renderChips();
  loadItems();
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadItems();
  }, 250);
});

async function loadAllItems() {
  const all = await api('/api/items');
  state.itemsById = new Map(all.map((i) => [i.id, i]));
}

async function loadItems() {
  const params = new URLSearchParams();
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  state.items = await api(`/api/items?${params}`);
  renderItems();
}

function renderItems() {
  const grid = $('#item-grid');
  grid.innerHTML = state.items
    .map((item) => {
      const sub = [item.color, item.subcategory || catOf(item.category).label, item.brand].filter(Boolean).join(' · ');
      return `<button class="item-card" data-id="${item.id}">${thumbHtml(item)}<div class="meta"><div class="name">${esc(item.name)}</div><div class="sub">${esc(sub)}</div></div></button>`;
    })
    .join('');
  const empty = $('#closet-empty');
  empty.hidden = state.items.length > 0;
  if (!state.items.length && (state.q || state.category)) {
    empty.innerHTML = '<div class="empty-emoji">🔍</div><p>조건에 맞는 옷이 없어요.</p>';
  } else if (!state.items.length) {
    empty.innerHTML = '<div class="empty-emoji">🧺</div><p>아직 등록된 옷이 없어요.<br />아래 <b>＋ 추가</b>를 눌러 옷 사진을 찍어 보세요.</p>';
  }
}

$('#item-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.item-card');
  if (card) openItemDialog(state.items.find((i) => i.id === card.dataset.id));
});

// 다른 화면에서 아이템 썸네일을 누르면 상세(수정) 화면을 연다.
document.addEventListener('click', (e) => {
  const ref = e.target.closest('[data-item]');
  if (!ref) return;
  const item = state.itemsById.get(ref.dataset.item);
  if (item) openItemDialog(item);
});

async function refreshCloset() {
  await Promise.all([loadMeta(), loadItems(), loadAllItems()]);
}

// ---------- 옷 추가/수정 ----------
const dialog = $('#item-dialog');
const form = $('#item-form');

function setupItemForm() {
  form.category.innerHTML = state.meta.categories.map((c) => `<option value="${c.id}">${c.emoji} ${esc(c.label)}</option>`).join('');
  $('#season-boxes').innerHTML = state.meta.seasons
    .map((s) => `<label class="toggle"><input type="checkbox" name="seasons" value="${s}" /><span>${s}</span></label>`)
    .join('');
}

function fillForm(data) {
  for (const key of ['name', 'category', 'subcategory', 'color', 'brand', 'size', 'notes']) {
    if (data[key] !== undefined && form[key]) form[key].value = data[key] ?? '';
  }
  if (data.tags) form.tags.value = data.tags.join(', ');
  if (data.seasons) $$('input[name=seasons]', form).forEach((b) => (b.checked = data.seasons.includes(b.value)));
  if (data.favorite !== undefined) form.favorite.checked = data.favorite;
}

function openItemDialog(item = null) {
  state.editing = item;
  state.itemImage = null;
  form.reset();
  $('#ai-status').hidden = true;
  $('#item-dialog-title').textContent = item ? '옷 정보' : '옷 추가';
  $('#delete-item').hidden = !item;
  const preview = $('#item-preview');
  if (item?.image) {
    preview.src = `/uploads/${item.image}`;
    preview.hidden = false;
  } else {
    preview.removeAttribute('src');
    preview.hidden = true;
  }
  if (item) fillForm(item);
  else if (state.category) form.category.value = state.category;
  dialog.showModal();
}

$('#add-btn').addEventListener('click', () => openItemDialog());
$('[data-close]', dialog).addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

$('#item-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const blob = await shrinkImage(file);
  state.itemImage = blob;
  const preview = $('#item-preview');
  preview.src = URL.createObjectURL(blob);
  preview.hidden = false;
  // 새 옷이면 사진만 올려도 AI가 정보를 자동으로 채운다.
  if (!state.editing) analyzePhoto(blob);
});

async function analyzePhoto(blob) {
  const status = $('#ai-status');
  status.hidden = false;
  status.textContent = '🤖 AI가 사진을 보고 정보를 채우는 중…';
  const fd = new FormData();
  fd.append('image', blob, 'photo.jpg');
  try {
    const result = await api('/api/ai/analyze', { method: 'POST', form: fd });
    if (state.itemImage !== blob) return; // 그 사이 다른 사진을 골랐으면 무시
    fillForm(result);
    status.textContent = '✅ AI가 채운 내용을 확인하고 저장하세요.';
  } catch (err) {
    status.textContent = `⚠️ ${err.message} 직접 입력해 주세요.`;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  for (const key of ['name', 'category', 'subcategory', 'color', 'brand', 'size', 'notes', 'tags']) fd.append(key, form[key].value);
  fd.append('seasons', JSON.stringify($$('input[name=seasons]:checked', form).map((b) => b.value)));
  fd.append('favorite', form.favorite.checked ? 'true' : 'false');
  if (state.itemImage) fd.append('image', state.itemImage, 'photo.jpg');
  const btn = $('#save-item');
  btn.disabled = true;
  try {
    if (state.editing) await api(`/api/items/${state.editing.id}`, { method: 'PATCH', form: fd });
    else await api('/api/items', { method: 'POST', form: fd });
    dialog.close();
    toast(state.editing ? '수정했어요.' : '옷장에 추가했어요! 👕');
    await refreshCloset();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#delete-item').addEventListener('click', async () => {
  if (!state.editing || !confirm(`'${state.editing.name}'을(를) 옷장에서 삭제할까요?`)) return;
  try {
    await api(`/api/items/${state.editing.id}`, { method: 'DELETE' });
    dialog.close();
    toast('삭제했어요.');
    await refreshCloset();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- 코디 추천 ----------
function miniHtml(id) {
  const item = state.itemsById.get(id);
  if (!item) return '';
  return `<button class="mini" data-item="${id}">${thumbHtml(item)}<span class="label">${esc(item.name)}</span></button>`;
}

function outfitCard(o, { saved = false, index } = {}) {
  const action = saved
    ? `<button class="btn small" data-delete-outfit="${o.id}">삭제</button>`
    : `<button class="btn small" data-save-outfit="${index}">💾 저장</button>`;
  return `<div class="card outfit">
    <div class="outfit-head"><h3>${esc(o.title)}</h3>${action}</div>
    <div class="strip">${o.item_ids.map(miniHtml).join('')}</div>
    ${o.description ? `<p>${esc(o.description)}</p>` : ''}
    ${o.tip ? `<p class="tip">💡 ${esc(o.tip)}</p>` : ''}
    ${saved && o.occasion ? `<p class="tip">📍 ${esc(o.occasion)}</p>` : ''}
  </div>`;
}

let lastOutfits = { outfits: [], occasion: '' };
$('#outfit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const box = $('#outfit-results');
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  box.innerHTML = loadingHtml('AI 스타일리스트가 옷장을 살펴보는 중…');
  try {
    await loadAllItems();
    const body = { occasion: f.occasion.value, weather: f.weather.value, style: f.style.value };
    const result = await api('/api/ai/outfits', { method: 'POST', json: body });
    lastOutfits = { outfits: result.outfits, occasion: body.occasion };
    box.innerHTML =
      result.outfits.map((o, i) => outfitCard(o, { index: i })).join('') +
      (result.missing_note ? `<p class="note">🛒 ${esc(result.missing_note)}</p>` : '');
    if (!result.outfits.length && !result.missing_note) box.innerHTML = '<p class="muted">추천할 코디를 찾지 못했어요.</p>';
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

$('#outfit-results').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save-outfit]');
  if (!btn) return;
  const o = lastOutfits.outfits[Number(btn.dataset.saveOutfit)];
  btn.disabled = true;
  try {
    await api('/api/outfits', {
      method: 'POST',
      json: { title: o.title, description: [o.description, o.tip].filter(Boolean).join('\n'), item_ids: o.item_ids, occasion: lastOutfits.occasion },
    });
    btn.textContent = '✅ 저장됨';
    renderSavedOutfits();
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
});

async function renderSavedOutfits() {
  const box = $('#saved-outfits');
  try {
    const outfits = await api('/api/outfits');
    box.innerHTML = outfits.length
      ? outfits.map((o) => outfitCard(o, { saved: true })).join('')
      : '<p class="muted small">마음에 드는 추천 코디를 저장하면 여기에 모여요.</p>';
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$('#saved-outfits').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-outfit]');
  if (!btn || !confirm('이 코디를 삭제할까요?')) return;
  await api(`/api/outfits/${btn.dataset.deleteOutfit}`, { method: 'DELETE' });
  renderSavedOutfits();
});

// ---------- 쇼핑 도우미 ----------
function refHtml(ref) {
  const item = state.itemsById.get(ref.id);
  if (!item) return '';
  return `<button class="ref" data-item="${item.id}">${thumbHtml(item)}<div><div class="t">${esc(item.name)}</div><div class="r">${esc(ref.reason)}</div></div></button>`;
}

const VERDICT = { buy: '👍 사도 좋아요', consider: '🤔 고민해 보세요', skip: '✋ 이미 비슷한 옷이 있어요' };

$('#shop-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  state.shopImage = await shrinkImage(file);
  const preview = $('#shop-preview');
  preview.src = URL.createObjectURL(state.shopImage);
  preview.hidden = false;
});

$('#shop-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const box = $('#shop-result');
  const btn = $('button[type=submit]', f);
  const fd = new FormData();
  fd.append('description', f.description.value);
  if (state.shopImage) fd.append('image', state.shopImage, 'shop.jpg');
  btn.disabled = true;
  box.innerHTML = loadingHtml('내 옷장과 비교하는 중…');
  try {
    await loadAllItems();
    const r = await api('/api/ai/shopping', { method: 'POST', form: fd });
    const d = r.detected;
    box.innerHTML = `<div class="card result form">
      <div><span class="verdict ${r.verdict}">${VERDICT[r.verdict] || r.verdict}</span></div>
      <h2>${esc(r.headline)}</h2>
      <p class="muted small">${catOf(d.category).emoji} ${esc(d.name)}${d.color ? ` · ${esc(d.color)}` : ''}</p>
      <p>${esc(r.reasoning)}</p>
      ${r.similar_items.length ? `<h3>이미 가진 비슷한 옷</h3><div class="ref-list">${r.similar_items.map(refHtml).join('')}</div>` : ''}
      ${r.pairs_with.length ? `<h3>함께 입기 좋은 내 옷</h3><div class="ref-list">${r.pairs_with.map(refHtml).join('')}</div>` : ''}
    </div>`;
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

$('#gap-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const box = $('#gap-result');
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  box.innerHTML = loadingHtml('옷장 전체를 분석하는 중…');
  try {
    await loadAllItems();
    const r = await api('/api/ai/gaps', { method: 'POST', json: { focus: f.focus.value } });
    const PRIO = { high: '꼭 필요', medium: '있으면 좋음', low: '여유 있을 때' };
    box.innerHTML = `<div class="card result">
      <p>${esc(r.summary)}</p>
      ${r.suggestions
        .map(
          (s) => `<div class="suggestion">
            <div><span class="prio ${s.priority}">${PRIO[s.priority] || s.priority}</span><b>${catOf(s.category).emoji} ${esc(s.item)}</b></div>
            <div class="muted small">${esc(s.reason)}</div>
            ${s.pairs_with.length ? `<div class="strip">${s.pairs_with.map(miniHtml).join('')}</div>` : ''}
          </div>`,
        )
        .join('')}
    </div>`;
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- 시작 ----------
async function start() {
  const session = await api('/api/session');
  if (session.authRequired && !session.authed) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout-btn').hidden = !session.authRequired;
  await refreshCloset();
  setupItemForm();
}

start().catch((err) => toast(err.message));
