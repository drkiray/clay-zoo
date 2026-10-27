'use strict';

const $ = (id) => document.getElementById(id);

const CW = 720;            // логический размер карточки
const CH = 1000;
const THUMB_SCALE = 0.4;   // для сетки коллекции
const MAX_PHOTO = 1024;    // длинная сторона фото при сохранении
const F_TITLE = "'Comfortaa', 'Nunito', system-ui, sans-serif";
const F_BODY = "'Nunito', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const state = { cards: [], draft: null, viewing: null, newId: null };
const thumbs = new Map(); // id -> <canvas> миниатюра

// ---------- Хранилище: IndexedDB, с запасным вариантом в памяти ----------
const DB = (() => {
  const mem = [];
  let db = null;
  let persistent = false;

  function open() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { settled = true; resolve(); };
      // если база не отвечает, не зависаем на пустом экране, а работаем в памяти
      setTimeout(() => { if (!settled) finish(); }, 4000);
      try {
        const req = indexedDB.open('clay-zoo', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('cards', { keyPath: 'id' });
        req.onsuccess = () => {
          if (!settled) { db = req.result; persistent = true; }
          finish();
        };
        req.onerror = finish;
        req.onblocked = finish;
      } catch (e) {
        finish();
      }
    });
  }

  function run(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cards', mode);
      const req = fn(tx.objectStore('cards'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  async function all() {
    if (persistent) {
      try { return await run('readonly', (s) => s.getAll()); } catch (e) { /* падаем в память */ }
    }
    return mem.slice();
  }

  async function put(card) {
    if (persistent) {
      try { await run('readwrite', (s) => s.put(card)); return true; } catch (e) { /* падаем в память */ }
    }
    mem.push(card);
    return false;
  }

  async function del(id) {
    if (persistent) {
      try { await run('readwrite', (s) => s.delete(id)); } catch (e) { /* игнор */ }
    }
    const i = mem.findIndex((c) => c.id === id);
    if (i >= 0) mem.splice(i, 1);
  }

  return { open, all, put, del, get persistent() { return persistent; } };
})();

// ---------- Утилиты ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const rarityOf = (id) => RARITIES.find((r) => r.id === id) || RARITIES[0];
const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[0];

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function confirmBox(text, yesLabel = 'Удалить') {
  return new Promise((resolve) => {
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yesLabel;
    $('confirm').hidden = false;
    const done = (v) => {
      $('confirm').hidden = true;
      $('confirmYes').onclick = $('confirmNo').onclick = null;
      resolve(v);
    };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

async function loadBitmap(src) {
  try {
    return await createImageBitmap(src, { imageOrientation: 'from-image' });
  } catch (e) {
    try { return await createImageBitmap(src); } catch (e2) { /* запасной путь ниже */ }
  }
  const url = URL.createObjectURL(src);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

// Фото -> уменьшенный canvas (для карточки) + JPEG Blob (для хранения)
async function preparePhoto(file) {
  const bmp = await loadBitmap(file);
  const w = bmp.naturalWidth || bmp.width;
  const h = bmp.naturalHeight || bmp.height;
  const k = Math.min(1, MAX_PHOTO / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const blob = await toBlob(canvas, 'image/jpeg', 0.88);
  if (!blob) throw new Error('toBlob failed');
  return { canvas, blob };
}

let fontsReady;
function ensureFonts() {
  if (!fontsReady) {
    const loads = Promise.all([
      document.fonts.load("700 40px 'Comfortaa'", 'Аа'),
      document.fonts.load("800 28px 'Nunito'", 'Аа'),
      document.fonts.load("700 28px 'Nunito'", 'Аа'),
    ]);
    const timeout = new Promise((r) => setTimeout(r, 2500));
    fontsReady = Promise.race([loads, timeout]).catch(() => {});
  }
  return fontsReady;
}

// ---------- Рисование карточки ----------
function rrPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function wrapText(c, text, maxW, maxLines) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (c.measureText(test).width <= maxW || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && c.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function sparkle(c, cx, cy, r) {
  c.beginPath();
  c.moveTo(cx, cy - r);
  c.quadraticCurveTo(cx, cy, cx + r, cy);
  c.quadraticCurveTo(cx, cy, cx, cy + r);
  c.quadraticCurveTo(cx, cy, cx - r, cy);
  c.quadraticCurveTo(cx, cy, cx, cy - r);
  c.closePath();
  c.fillStyle = '#fff';
  c.fill();
  c.lineWidth = 2;
  c.strokeStyle = '#ffb23e';
  c.stroke();
}

function paint(canvas, card, img, scale = 1) {
  const R = rarityOf(card.rarity);
  const T = typeOf(card.type);
  canvas.width = Math.round(CW * scale);
  canvas.height = Math.round(CH * scale);
  const c = canvas.getContext('2d');
  c.setTransform(scale, 0, 0, scale, 0, 0);
  c.clearRect(0, 0, CW, CH);
  c.textBaseline = 'middle';

  // рамка
  const g = c.createLinearGradient(0, 0, CW, CH);
  R.frame.forEach((col, i) => g.addColorStop(i / (R.frame.length - 1), col));
  rrPath(c, 0, 0, CW, CH, 52);
  c.fillStyle = g;
  c.fill();

  // внутренняя панель
  rrPath(c, 22, 22, CW - 44, CH - 44, 36);
  c.fillStyle = R.panel;
  c.fill();

  // шапка: значок типа, плашка редкости, лапка
  for (const [cx, emoji] of [[84, T.emoji], [CW - 84, '🐾']]) {
    c.beginPath();
    c.arc(cx, 72, 30, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = R.accent;
    c.stroke();
    c.font = `30px ${F_BODY}`;
    c.textAlign = 'center';
    c.fillStyle = '#000';
    c.fillText(emoji, cx, 74);
  }
  const rl = '★'.repeat(R.stars) + ' ' + R.label.toUpperCase();
  c.font = `800 25px ${F_BODY}`;
  const pw = Math.min(380, Math.max(220, c.measureText(rl).width + 44));
  rrPath(c, CW / 2 - pw / 2, 46, pw, 52, 26);
  c.fillStyle = R.accent;
  c.fill();
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.fillText(rl, CW / 2, 73);

  // фото
  const px = 48, py = 118, pwid = 624, ph = 440;
  c.save();
  rrPath(c, px, py, pwid, ph, 28);
  c.clip();
  const bg = c.createLinearGradient(px, py, px + pwid, py + ph);
  bg.addColorStop(0, '#ffe3f1');
  bg.addColorStop(1, '#e6dcff');
  c.fillStyle = bg;
  c.fillRect(px, py, pwid, ph);
  if (img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const k = Math.max(pwid / iw, ph / ih);
    const sw = pwid / k, sh = ph / k;
    c.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, px, py, pwid, ph);
  } else {
    c.font = `140px ${F_BODY}`;
    c.textAlign = 'center';
    c.fillText(T.emoji, CW / 2, py + ph / 2);
  }
  c.restore();
  rrPath(c, px, py, pwid, ph, 28);
  c.lineWidth = 6;
  c.strokeStyle = R.accent;
  c.stroke();

  // имя (подгоняем размер под ширину)
  const name = card.name || '';
  let size = 54;
  c.font = `700 ${size}px ${F_TITLE}`;
  while (size > 28 && c.measureText(name).width > 590) {
    size -= 2;
    c.font = `700 ${size}px ${F_TITLE}`;
  }
  c.fillStyle = '#3b2147';
  c.textAlign = 'center';
  c.fillText(name, CW / 2, 604);

  // суперсила
  rrPath(c, 48, 646, 624, 134, 24);
  c.fillStyle = '#fff';
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = R.accent + '66';
  c.stroke();
  c.textAlign = 'left';
  c.fillStyle = R.accent;
  c.font = `800 18px ${F_BODY}`;
  c.fillText('✦ СУПЕРСИЛА', 72, 670);
  c.fillStyle = '#4a2a55';
  c.font = `700 26px ${F_BODY}`;
  const lines = wrapText(c, card.power || '', 576, 3);
  const top = 688 + (92 - lines.length * 31) / 2;
  lines.forEach((ln, i) => c.fillText(ln, 72, top + 15 + i * 31));

  // характеристики
  const stats = card.stats || [];
  const step = stats.length <= 3 ? 52 : 42;
  stats.forEach((s, i) => {
    const y = 822 + i * step;
    c.font = `800 22px ${F_BODY}`;
    c.textAlign = 'left';
    c.fillStyle = '#7a5a88';
    c.fillText(s.k, 60, y);
    rrPath(c, 215, y - 10, 360, 20, 10);
    c.fillStyle = 'rgba(74, 42, 85, .12)';
    c.fill();
    const bw = Math.max(20, 360 * Math.max(0, Math.min(100, s.v)) / 100);
    const bgrad = c.createLinearGradient(215, 0, 215 + bw, 0);
    bgrad.addColorStop(0, R.bar[0]);
    bgrad.addColorStop(1, R.bar[1]);
    rrPath(c, 215, y - 10, bw, 20, 10);
    c.fillStyle = bgrad;
    c.fill();
    c.textAlign = 'right';
    c.fillStyle = '#4a2a55';
    c.fillText(String(s.v), 660, y);
  });

  // легендарный блеск в PNG (в приложении ещё бегает анимация)
  if (card.rarity === 'legendary') {
    rrPath(c, 22, 22, CW - 44, CH - 44, 36);
    c.lineWidth = 4;
    c.strokeStyle = '#ffd24d';
    c.stroke();
    const rnd = seeded(card.id || card.name || 'x');
    for (let i = 0; i < 9; i++) {
      const side = Math.floor(rnd() * 4);
      const t = rnd();
      const x = side < 2 ? 14 + t * (CW - 28) : (side === 2 ? 12 : CW - 12);
      const y = side < 2 ? (side === 0 ? 12 : CH - 12) : 14 + t * (CH - 28);
      sparkle(c, x, y, 9 + rnd() * 9);
    }
    for (let i = 0; i < 7; i++) {
      sparkle(c, px + 30 + rnd() * (pwid - 60), py + 30 + rnd() * (ph - 60), 8 + rnd() * 14);
    }
  }
}

// Рисуем сохранённую карточку (фото -> bitmap -> canvas)
async function drawStored(card, canvas, scale) {
  await ensureFonts();
  const bmp = await loadBitmap(card.photo);
  paint(canvas, card, bmp, scale);
  if (bmp.close) bmp.close();
}

async function renderPng(card, img) {
  await ensureFonts();
  const canvas = document.createElement('canvas');
  let bmp = null;
  if (!img) { bmp = await loadBitmap(card.photo); img = bmp; }
  paint(canvas, card, img, 1);
  if (bmp && bmp.close) bmp.close();
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) throw new Error('png failed');
  return blob;
}

function fileName(card) {
  const base = (card.name || 'карточка').replace(/[^\p{L}\p{N}\- ]/gu, '').trim() || 'карточка';
  return base + '.png';
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function saveCard(card, img) {
  try {
    downloadBlob(await renderPng(card, img), fileName(card));
    toast('Сохранено! Ищи картинку в галерее или в загрузках 📥');
  } catch (e) {
    toast('Не получилось сохранить 😿 Попробуй ещё раз');
  }
}

async function shareCard(card, img) {
  let blob;
  try { blob = await renderPng(card, img); } catch (e) { toast('Не получилось подготовить картинку 😿'); return; }
  const file = new File([blob], fileName(card), { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: card.name, text: `${card.name} — мой глиняный друг!` });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  downloadBlob(blob, fileName(card));
  toast('Поделиться тут нельзя, поэтому картинка сохранена. Отправь её из галереи 📤', 4200);
}

// ---------- Экраны ----------
function show(view) {
  $('home').hidden = view !== 'home';
  $('create').hidden = view !== 'create';
  window.scrollTo(0, 0);
}

// Кнопка «Назад» телефона закрывает карточку / экран создания
function syncFromHistory() {
  const v = history.state && history.state.v;
  $('viewer').hidden = v !== 'viewer';
  if (v !== 'viewer') state.viewing = null;
  if (v === 'create') { show('create'); } else { show('home'); renderGrid(); }
}
window.addEventListener('popstate', syncFromHistory);

function thumbFor(card) {
  let c = thumbs.get(card.id);
  if (!c) {
    c = document.createElement('canvas');
    c.width = Math.round(CW * THUMB_SCALE);
    c.height = Math.round(CH * THUMB_SCALE);
    thumbs.set(card.id, c);
    drawStored(card, c, THUMB_SCALE).catch(() => {});
  }
  return c;
}

function renderGrid() {
  const n = state.cards.length;
  $('title').textContent = 'Зоопарк ' + OWNER_GEN;
  $('count').textContent = n ? `Героев в зоопарке: ${n}` : 'Пока тут пусто. Сфотографируй первую фигурку!';

  const nodes = state.cards.map((card) => {
    const b = document.createElement('button');
    b.className = 'tile' + (card.rarity === 'legendary' ? ' legendary' : '') + (card.id === state.newId ? ' new' : '');
    b.setAttribute('aria-label', card.name);
    b.appendChild(thumbFor(card));
    b.onclick = () => openViewer(card);
    return b;
  });
  state.newId = null;

  const slots = Math.max(2, 4 - n);
  for (let i = 0; i < slots; i++) {
    const s = document.createElement('button');
    s.className = 'slot';
    s.innerHTML = '<span>🐾</span><span>Здесь появится новый друг</span>';
    s.onclick = openCreate;
    nodes.push(s);
  }
  $('grid').replaceChildren(...nodes);
}

function openViewer(card) {
  state.viewing = card;
  history.pushState({ v: 'viewer' }, '');
  $('viewer').hidden = false;
  $('viewWrap').classList.toggle('legendary', card.rarity === 'legendary');
  drawStored(card, $('viewCanvas'), 1).catch(() => toast('Не получилось открыть карточку 😿'));
}

// ---------- Создание карточки ----------
function openCreate() {
  state.draft = null;
  $('pickStep').hidden = false;
  $('editStep').hidden = true;
  history.pushState({ v: 'create' }, '');
  show('create');
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(async () => {
    paintQueued = false;
    const d = state.draft;
    if (!d) return;
    await ensureFonts();
    paint($('preview'), d, d.img, 1);
  });
}

function announceRarity(r) {
  if (r === 'legendary') toast('🌟 ЛЕГЕНДАРНАЯ карточка! Вот это удача!', 3600);
  else if (r === 'epic') toast('💜 Эпическая карточка!');
}

function popPreview() {
  const w = $('previewWrap');
  w.classList.remove('pop');
  void w.offsetWidth;
  w.classList.add('pop');
}

function syncEditUI() {
  const d = state.draft;
  document.querySelectorAll('#chips .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === d.type)));
  $('inName').value = d.name;
  $('inPower').value = d.power;
  $('previewWrap').classList.toggle('legendary', d.rarity === 'legendary');
  schedulePaint();
}

async function handleFile(file) {
  if (!file) return;
  try {
    toast('Колдуем карточку… ✨', 1500);
    const { canvas, blob } = await preparePhoto(file);
    const rolled = Gen.roll(Gen.pick(TYPES).id);
    state.draft = { ...rolled, img: canvas, blob };
    $('pickStep').hidden = true;
    $('editStep').hidden = false;
    window.scrollTo(0, 0);
    syncEditUI();
    popPreview();
    announceRarity(rolled.rarity);
  } catch (e) {
    toast('Не получилось открыть фото 😿 Попробуй другое');
  }
}

function buildChips() {
  $('chips').replaceChildren(...TYPES.map((t) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.type = t.id;
    b.innerHTML = `<span>${t.emoji}</span><span>${t.label}</span>`;
    b.onclick = () => {
      const d = state.draft;
      if (!d || d.type === t.id) return;
      d.type = t.id;
      d.name = Gen.name(t.id);
      d.power = Gen.power(t.id);
      syncEditUI();
    };
    return b;
  }));
}

async function addToZoo() {
  const d = state.draft;
  if (!d) return;
  $('btnAdd').disabled = true;
  try {
    const card = {
      id: uid(), created: Date.now(), type: d.type, rarity: d.rarity, stats: d.stats,
      name: d.name.trim() || 'Без имени', power: d.power.trim() || 'пока скрывает свою силу', photo: d.blob,
    };
    const stored = await DB.put(card);
    state.cards.unshift(card);
    state.newId = card.id;
    state.draft = null;
    history.back(); // popstate вернёт на главную и перерисует сетку
    toast(stored ? 'Добавлено в зоопарк! 🎉' : 'Добавлено, но память не сохранится после закрытия 😿', 3200);
  } finally {
    $('btnAdd').disabled = false;
  }
}

// ---------- События ----------
function wire() {
  $('btnNew').onclick = openCreate;
  $('createBack').onclick = () => history.back();
  $('viewClose').onclick = () => history.back();
  $('viewer').onclick = (e) => { if (e.target === $('viewer')) history.back(); };

  $('btnCamera').onclick = () => $('camInput').click();
  $('btnGallery').onclick = () => $('galInput').click();
  for (const id of ['camInput', 'galInput']) {
    $(id).onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      handleFile(f);
    };
  }
  $('btnRetake').onclick = () => { state.draft = null; $('pickStep').hidden = false; $('editStep').hidden = true; window.scrollTo(0, 0); };

  $('rrName').onclick = () => { const d = state.draft; d.name = Gen.name(d.type, d.name); syncEditUI(); };
  $('rrPower').onclick = () => { const d = state.draft; d.power = Gen.power(d.type, d.power); syncEditUI(); };
  $('rrAll').onclick = () => {
    const d = state.draft;
    Object.assign(d, Gen.roll(d.type));
    syncEditUI();
    popPreview();
    announceRarity(d.rarity);
  };
  $('inName').oninput = (e) => { state.draft.name = e.target.value; schedulePaint(); };
  $('inPower').oninput = (e) => { state.draft.power = e.target.value; schedulePaint(); };

  $('btnAdd').onclick = addToZoo;
  $('btnSaveNew').onclick = () => saveCard(state.draft, state.draft.img);
  $('btnShareNew').onclick = () => shareCard(state.draft, state.draft.img);

  $('btnSaveView').onclick = () => saveCard(state.viewing);
  $('btnShareView').onclick = () => shareCard(state.viewing);
  $('btnDelete').onclick = async () => {
    const card = state.viewing;
    if (!card) return;
    if (!(await confirmBox(`Удалить «${card.name}» из зоопарка? Вернуть не получится.`))) return;
    await DB.del(card.id);
    state.cards = state.cards.filter((c) => c.id !== card.id);
    thumbs.delete(card.id);
    history.back();
    toast('Карточка удалена');
  };
}

async function init() {
  $('splashName').textContent = OWNER_GEN;
  document.title = 'Зоопарк ' + OWNER_GEN;
  buildChips();
  wire();

  await DB.open();
  try { state.cards = (await DB.all()).sort((a, b) => b.created - a.created); } catch (e) { state.cards = []; }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* не страшно */ }

  if (!DB.persistent) {
    $('notice').hidden = false;
    $('notice').textContent = 'Память телефона недоступна: карточки пропадут после закрытия. Сохраняй картинки кнопкой 💾.';
  }

  history.replaceState(null, '');
  renderGrid();
  let seen = false;
  try { seen = localStorage.getItem('clay-zoo-seen') === '1'; } catch (e) { /* без заставки-памяти */ }
  if (seen) {
    show('home');
  } else {
    $('splash').hidden = false;
    $('btnStart').onclick = () => {
      try { localStorage.setItem('clay-zoo-seen', '1'); } catch (e) { /* ок */ }
      $('splash').hidden = true;
      show('home');
    };
  }
  ensureFonts();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
