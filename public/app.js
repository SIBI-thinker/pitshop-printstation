(() => {
  const $ = (id) => document.getElementById(id);
  const KEYS = { order: 'print.order', settings: 'print.settings', customer: 'print.customer' };
  const LABELS = {
    color: { bw: 'Black & white', color: 'Colour' },
    sides: { single: 'Single-sided', 'double-long': 'Double-sided, long edge', 'double-short': 'Double-sided, short edge' },
    orientation: { auto: 'Auto orientation', portrait: 'Portrait', landscape: 'Landscape' },
    scale: { fit: 'Fit to page', shrink: 'Shrink only', noscale: 'Actual size' },
  };
  const SHORT = {
    color: { bw: 'B&W', color: 'Colour' },
    sides: { single: '1-sided', 'double-long': '2-sided', 'double-short': '2-sided, flip up' },
    orientation: { auto: '', portrait: 'Portrait', landscape: 'Landscape' },
    scale: { fit: '', shrink: 'Shrink only', noscale: 'Actual size' },
  };
  const STATUS = {
    waiting: ['warn', 'Waiting at the counter', 'Show this PIN at the counter. Nothing prints until staff confirm it.'],
    queued: ['info busy', 'In the print queue', 'Your order is next in line.'],
    printing: ['info busy', 'Printing now', 'Your pages are coming out of the printer.'],
    printed: ['ok', 'Printed', 'All done. Collect your pages at the counter.'],
    failed: ['bad', 'Printing problem', 'Something went wrong at the printer. Please ask at the counter.'],
    rejected: ['bad', 'Declined', 'The counter declined this order. Please ask staff for help.'],
  };

  let info = { shopName: 'Print Station', accept: '', limits: { maxCustomers: 10, maxUploadMb: 20, maxFiles: 10, maxPages: 300, maxCopies: 20 }, options: { color: true, duplex: true, paperSizes: ['A4'] } };
  let order = null;
  let defaults = {};
  let pollTimer = null;
  const uploads = [];
  let uploading = false;
  // Files picked on this phone, so previews draw from the local copy instead of downloading it again.
  const localFiles = new Map();
  // The file open in the editor: { id, settings, dirty, redraw }.
  let editing = null;

  // ---------- small helpers ----------
  const storage = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
    drop(key) { try { localStorage.removeItem(key); } catch (_) {} },
  };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const copiesText = (n) => `${n} ${n === 1 ? 'copy' : 'copies'}`;
  let toastTimer;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
  }
  async function api(url, options = {}) {
    const init = { method: options.method || 'GET', headers: {} };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (_) {
      throw new Error('Cannot reach the print station. Check that you are on its Wi-Fi.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || 'Something went wrong. Please try again.');
      error.status = res.status;
      throw error;
    }
    return data;
  }

  // ---------- settings ----------
  function normalizeSettings(input = {}) {
    const opts = info.options;
    const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
    return {
      color: opts.color ? pick(input.color, ['bw', 'color'], 'bw') : 'bw',
      sides: opts.duplex ? pick(input.sides, ['single', 'double-long', 'double-short'], 'single') : 'single',
      orientation: pick(input.orientation, ['auto', 'portrait', 'landscape'], 'auto'),
      paper: pick(input.paper, opts.paperSizes, opts.paperSizes[0]),
      scale: pick(input.scale, ['fit', 'shrink', 'noscale'], 'fit'),
      copies: Math.min(info.limits.maxCopies, Math.max(1, parseInt(input.copies, 10) || 1)),
    };
  }
  function settingChips(s) {
    return [SHORT.color[s.color], SHORT.sides[s.sides], SHORT.orientation[s.orientation], s.paper, SHORT.scale[s.scale], s.copies > 1 ? copiesText(s.copies) : ''].filter(Boolean);
  }
  function longChips(s) {
    return [LABELS.color[s.color], LABELS.sides[s.sides], LABELS.orientation[s.orientation], s.paper, LABELS.scale[s.scale], copiesText(s.copies)];
  }
  function fileTotals(file, s = file.settings) {
    const selected = file.status === 'ready' ? file.selected : 0;
    const perCopy = s.sides === 'single' ? selected : Math.ceil(selected / 2);
    return { pages: selected * s.copies, sheets: perCopy * s.copies };
  }

  // ---------- screens ----------
  function show(screen) {
    for (const name of ['start', 'order', 'pin']) $(`${name}Screen`).hidden = name !== screen;
    $('summaryBar').hidden = screen !== 'order';
    $('cancelOrder').hidden = !(order && ['draft', 'waiting'].includes(order.status) && screen !== 'start');
    window.scrollTo(0, 0);
  }

  function route() {
    if (!order) return showStart();
    storage.set(KEYS.order, order.id);
    // Settings changed in the editor but not saved yet win over what the server sent.
    if (editing) {
      const file = order.files.find((item) => item.id === editing.id);
      if (!file || order.status !== 'draft') closeEditor(false);
      else if (editing.dirty) file.settings = { ...editing.settings };
    }
    if (order.status === 'draft') {
      if ($('orderScreen').hidden) show('order');
      renderOrder();
    } else {
      if ($('pinScreen').hidden) show('pin');
      renderPin();
    }
    schedulePoll();
  }

  function showStart(resumeSingle = false) {
    order = null;
    closeEditor(false);
    storage.drop(KEYS.order);
    const customer = storage.get(KEYS.customer) || {};
    $('name').value = customer.name || '';
    $('mobile').value = customer.mobile || '';
    $('startForm').hidden = false;
    show('start');
    showOpenOrders(resumeSingle);
  }

  // Orders this phone already has open on the server, found by its Wi-Fi address. This keeps an
  // order reachable even when the browser lost its saved copy.
  async function showOpenOrders(resumeSingle = false) {
    let mine = [];
    try {
      mine = (await api('/api/orders/mine')).orders;
    } catch (_) {}
    if (resumeSingle && mine.length === 1) return resume(mine[0].id);
    const STATE = { draft: 'Not confirmed yet', waiting: 'Waiting at the counter', queued: 'In the print queue', printing: 'Printing now' };
    $('openOrderList').replaceChildren(...mine.map((item) => {
      const row = el('button', 'file clickable');
      row.type = 'button';
      row.style.textAlign = 'left';
      row.style.width = '100%';
      const main = el('div', 'file-main');
      main.append(el('div', 'file-name', `${item.name}${item.pin ? ` · PIN ${item.pin}` : ''}`));
      main.append(el('div', 'file-meta', `${STATE[item.status] || item.status} · ${plural(item.files, 'file')} · started ${new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
      row.append(el('div', 'file-icon', '↺'), main, el('span', 'link-btn preview', 'Continue'));
      row.onclick = () => resume(item.id);
      return row;
    }));
    $('openOrders').hidden = !mine.length;
  }

  async function resume(id) {
    try {
      order = await api(`/api/orders/${id}`);
    } catch (err) {
      toast(err.message);
      return showOpenOrders();
    }
    route();
  }

  // ---------- file rows ----------
  function typeLabel(name) {
    const ext = (name.split('.').pop() || '').toUpperCase();
    return ext.length <= 4 ? ext : 'FILE';
  }
  function kindOf(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (['png', 'jpg', 'jpeg'].includes(ext)) return 'image';
    return 'office';
  }
  function previewSource(file) {
    return { key: file.id, kind: file.kind, size: file.size, url: `/api/orders/${order.id}/files/${file.id}`, blob: localFiles.get(file.id) };
  }
  function pagesLine(file) {
    const { pages, sheets } = fileTotals(file);
    const picked = file.selected === file.pages ? plural(file.pages, 'page') : `${file.selected} of ${file.pages} pages`;
    return `${picked} · prints ${plural(pages, 'page')} on ${plural(sheets, 'sheet')}`;
  }

  function fileRow(file, mode) {
    const ready = file.status === 'ready';
    const row = el('div', `file${ready ? ' clickable' : ''}`);
    const icon = el('div', `file-icon ${file.kind}`, typeLabel(file.name));
    row.append(icon);
    const main = el('div', 'file-main');
    main.append(el('div', 'file-name', file.name));
    const meta = el('div', 'file-meta');
    if (file.status === 'processing') {
      meta.append(el('span', 'spinner'), document.createTextNode(file.kind === 'office' ? ' Converting…' : ' Counting pages…'));
    } else if (file.status === 'error') {
      meta.classList.add('error');
      meta.textContent = file.error || 'This file could not be read.';
    } else {
      meta.textContent = pagesLine(file);
    }
    main.append(meta);
    if (ready) {
      const chips = el('div', 'file-settings');
      chips.append(...settingChips(file.settings).map((text) => el('span', 'chip', text)));
      main.append(chips);
      window.PrintPreview.thumb(icon, { file: previewSource(file), range: file.range, settings: file.settings, pages: file.pages });
      row.onclick = () => (mode === 'edit' ? openEditor(file) : openPreview(file));
    }
    row.append(main);
    if (mode === 'edit') {
      const remove = el('button', 'icon-btn', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.onclick = (event) => {
        event.stopPropagation();
        removeFile(file);
      };
      row.append(remove);
    } else {
      row.append(el('span'));
    }
    return row;
  }

  function openPreview(file) {
    const { pages, sheets } = fileTotals(file);
    window.PrintPreview.open({
      title: file.name,
      subtitle: `${plural(sheets / file.settings.copies, 'sheet')} per copy · ${plural(pages, 'page')} in total`,
      chips: longChips(file.settings),
      file: previewSource(file),
      pages: file.pages,
      range: file.range,
      settings: file.settings,
    });
  }

  // ---------- uploads ----------
  async function removeFile(file) {
    try {
      order = await api(`/api/orders/${order.id}/files/${file.id}`, { method: 'DELETE' });
      route();
    } catch (err) {
      toast(err.message);
    }
  }

  function addFiles(list) {
    const room = info.limits.maxFiles - order.files.length - uploads.length;
    const chosen = [...list];
    if (chosen.length > room) toast(`You can add ${plural(Math.max(room, 0), 'more file')}.`);
    for (const file of chosen.slice(0, Math.max(room, 0))) {
      if (file.size > info.limits.maxUploadMb * 1024 * 1024) {
        toast(`${file.name} is larger than ${info.limits.maxUploadMb} MB.`);
        continue;
      }
      uploads.push({ file, name: file.name, kind: kindOf(file.name), progress: 0 });
    }
    renderOrder();
    pumpUploads();
  }

  function sendFile(item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/orders/${order.id}/files`);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        item.progress = event.loaded / event.total;
        const bar = document.querySelector(`[data-upload="${uploads.indexOf(item)}"] .progress i`);
        if (bar) bar.style.width = `${Math.round(item.progress * 100)}%`;
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Upload failed.'), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Check your Wi-Fi connection.'));
      const form = new FormData();
      // New files start with the settings used last.
      form.append('settings', JSON.stringify(defaults));
      form.append('file', item.file);
      xhr.send(form);
    });
  }

  async function pumpUploads() {
    if (uploading) return;
    uploading = true;
    while (uploads.length) {
      const item = uploads[0];
      try {
        const before = new Set(order.files.map((file) => file.id));
        order = await sendFile(item);
        const added = order.files.find((file) => !before.has(file.id));
        if (added) localFiles.set(added.id, item.file);
      } catch (err) {
        toast(`${item.name}: ${err.message}`);
        if (err.status === 404) {
          uploads.length = 0;
          uploading = false;
          return expired();
        }
      }
      uploads.shift();
      route();
    }
    uploading = false;
    renderOrder();
  }

  function renderFiles() {
    const list = $('fileList');
    list.replaceChildren();
    for (const file of order.files) list.append(fileRow(file, 'edit'));
    uploads.forEach((item, index) => {
      const row = el('div', 'file');
      row.dataset.upload = index;
      row.append(el('div', `file-icon ${item.kind}`, typeLabel(item.name)));
      const main = el('div', 'file-main');
      main.append(el('div', 'file-name', item.name));
      main.append(el('div', 'file-meta', index === 0 ? 'Uploading…' : 'Waiting to upload'));
      const bar = el('div', 'progress');
      const fill = el('i');
      fill.style.width = `${Math.round(item.progress * 100)}%`;
      bar.append(fill);
      main.append(bar);
      row.append(main, el('span'));
      list.append(row);
    });
    const count = order.files.length + uploads.length;
    $('fileCount').textContent = `${count} of ${info.limits.maxFiles}`;
    $('drop').hidden = count >= info.limits.maxFiles;
  }

  function renderOrder() {
    renderFiles();
    renderSummary();
  }

  // ---------- totals ----------
  function totals() {
    const result = { files: 0, pages: 0, sheets: 0 };
    for (const file of order.files) {
      if (file.status !== 'ready') continue;
      const t = fileTotals(file);
      result.files++;
      result.pages += t.pages;
      result.sheets += t.sheets;
    }
    return result;
  }

  function renderSummary() {
    const sum = totals();
    const busy = uploads.length > 0 || order.files.some((file) => file.status === 'processing');
    const broken = order.files.some((file) => file.status === 'error');
    const tooMany = sum.pages > info.limits.maxPages;
    $('sumPages').textContent = plural(sum.pages, 'page');
    let detail = `${plural(sum.files, 'file')} · ${plural(sum.sheets, 'sheet')} of paper`;
    if (!order.files.length && !uploads.length) detail = 'Add a file to begin';
    else if (busy) detail = 'Preparing your files…';
    else if (broken) detail = 'Remove the files marked in red';
    else if (tooMany) detail = `Limit is ${info.limits.maxPages} pages per order`;
    $('sumDetail').textContent = detail;
    $('reviewBtn').disabled = !sum.files || busy || broken || tooMany;
  }

  // ---------- per-file editor ----------
  function openEditor(file) {
    editing = { id: file.id, settings: normalizeSettings(file.settings), dirty: false, redraw: null };
    $('edName').textContent = file.name;
    $('rangeInput').value = file.range === 'all' ? '' : file.range;
    $('rangeError').hidden = true;
    $('pagesOption').hidden = file.pages <= 1;
    $('edAll').hidden = order.files.length < 2;
    $('editor').hidden = false;
    document.body.style.overflow = 'hidden';
    const strip = $('edSheets');
    editing.redraw = window.PrintPreview.sheetsView(strip, {
      file: previewSource(file),
      pages: file.pages,
      range: file.range,
      settings: editing.settings,
      // A whole sheet (front and back together when double-sided) fits on screen; the strip scrolls sheet by sheet.
      box: (duplex) => {
        const height = Math.max(120, strip.clientHeight - 64);
        const width = (strip.clientWidth - 40 - (duplex ? 10 : 0)) / (duplex ? 2 : 1);
        return [Math.min(height * 1.42, width), height];
      },
    });
    updateEditor();
  }

  function editingFile() {
    return editing && order.files.find((item) => item.id === editing.id);
  }

  function updateEditor() {
    const file = editingFile();
    if (!file) return;
    const s = editing.settings;
    for (const seg of document.querySelectorAll('#editor .seg')) {
      const key = seg.dataset.setting;
      const current = key === 'duplex' ? (s.sides === 'single' ? 'single' : 'double') : s[key];
      for (const button of seg.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === current));
    }
    $('flipOption').hidden = s.sides === 'single';
    $('copies').textContent = s.copies;
    $('copiesDown').disabled = s.copies <= 1;
    $('copiesUp').disabled = s.copies >= info.limits.maxCopies;
    $('edPagesInfo').textContent = file.selected === file.pages ? `all ${file.pages}` : `${file.selected} of ${file.pages}`;
    const t = fileTotals(file, s);
    $('edSummary').textContent = `${plural(t.sheets / s.copies, 'sheet')} per copy · ${plural(t.pages, 'page')} in total`;
    $('edBadge').hidden = s.copies < 2;
    $('edBadge').textContent = `× ${copiesText(s.copies)}`;
  }

  function changeSetting(key, value) {
    const s = editing.settings;
    if (key === 'duplex') s.sides = value === 'single' ? 'single' : s.sides === 'single' ? 'double-long' : s.sides;
    else if (key === 'copies') s.copies = Math.min(info.limits.maxCopies, Math.max(1, value));
    else s[key] = value;
    editing.dirty = true;
    defaults = { ...s };
    storage.set(KEYS.settings, defaults);
    const file = editingFile();
    file.settings = { ...s };
    updateEditor();
    editing.redraw(file.range, s);
    renderOrder();
    clearTimeout(editing.timer);
    editing.timer = setTimeout(saveEditing, 500);
  }

  async function saveEditing() {
    if (!editing || !editing.dirty) return;
    clearTimeout(editing.timer);
    const { id, settings } = editing;
    editing.dirty = false;
    try {
      order = await api(`/api/orders/${order.id}/files/${id}`, { method: 'PATCH', body: { settings } });
      route();
    } catch (err) {
      toast(err.message);
      if (err.status === 404) expired();
    }
  }

  async function applyRange(event) {
    event.preventDefault();
    const file = editingFile();
    const range = $('rangeInput').value.trim() || 'all';
    try {
      order = await api(`/api/orders/${order.id}/files/${file.id}`, { method: 'PATCH', body: { range } });
      $('rangeError').hidden = true;
      $('rangeInput').blur();
      route();
      const updated = editingFile();
      $('rangeInput').value = updated.range === 'all' ? '' : updated.range;
      editing.redraw(updated.range, editing.settings);
      updateEditor();
    } catch (err) {
      $('rangeError').textContent = err.message;
      $('rangeError').hidden = false;
    }
  }

  async function applyToAll() {
    await saveEditing();
    try {
      order = await api(`/api/orders/${order.id}/files`, { method: 'PATCH', body: { settings: editing.settings } });
      toast(`Applied to all ${plural(order.files.length, 'file')}`);
      route();
    } catch (err) {
      toast(err.message);
    }
  }

  function closeEditor(save = true) {
    if (!editing) return;
    if (save) saveEditing();
    editing = null;
    $('editor').hidden = true;
    $('edSheets').replaceChildren();
    document.body.style.overflow = '';
  }

  // ---------- review and confirm ----------
  function openReview() {
    const sum = totals();
    const list = $('reviewRows');
    list.replaceChildren();
    const addRow = (label, value, note) => {
      const row = el('div');
      const right = el('strong', '', value);
      if (note) {
        right.append(el('br'), el('span', 'muted small', note));
        right.lastChild.style.fontWeight = '500';
      }
      row.append(el('dt', '', label), right);
      list.append(row);
    };
    addRow('Name', order.name);
    addRow('Mobile', order.mobile);
    for (const file of order.files) {
      const t = fileTotals(file);
      addRow(file.name, `${plural(t.pages, 'page')} · ${plural(t.sheets, 'sheet')}`, settingChips(file.settings).join(' · '));
    }
    addRow('Total to print', plural(sum.pages, 'page'));
    addRow('Sheets of paper', plural(sum.sheets, 'sheet'));
    $('reviewSheet').hidden = false;
    $('confirmBtn').focus();
  }

  async function confirmOrder() {
    const button = $('confirmBtn');
    button.disabled = true;
    try {
      order = await api(`/api/orders/${order.id}/confirm`, { method: 'POST' });
      $('reviewSheet').hidden = true;
      route();
    } catch (err) {
      toast(err.message);
      if (err.status === 404) expired();
    } finally {
      button.disabled = false;
    }
  }

  // ---------- PIN screen ----------
  function renderPin() {
    const [tone, title, text] = STATUS[order.status] || STATUS.waiting;
    const pill = $('statusPill');
    pill.className = `pill ${tone}`;
    pill.textContent = title;
    $('statusText').textContent = text;
    $('pinDigits').replaceChildren(...String(order.pin || '----').split('').map((digit) => el('span', '', digit)));
    $('pinPages').textContent = order.totals.pages;
    $('pinSheets').textContent = order.totals.sheets;
    $('pinExpiry').textContent = order.status === 'waiting' && order.expiresAt
      ? `PIN valid until ${new Date(order.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    $('pinFiles').replaceChildren(...order.files.map((file) => fileRow(file, 'view')));
    $('editOrder').hidden = order.status !== 'waiting';
    $('newOrder').hidden = !['printed', 'failed', 'rejected'].includes(order.status);
    $('cancelOrder').hidden = order.status !== 'waiting';
  }

  // ---------- polling (only while something is changing) ----------
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!order || document.hidden) return;
    const preparing = order.status === 'draft' && order.files.some((file) => file.status === 'processing');
    const live = ['waiting', 'queued', 'printing'].includes(order.status);
    if (!preparing && !live) return;
    pollTimer = setTimeout(refresh, preparing ? 1500 : 4000);
  }

  async function refresh() {
    if (!order) return;
    try {
      const before = order.status;
      order = await api(`/api/orders/${order.id}`);
      if (before !== order.status && order.status === 'printed' && navigator.vibrate) navigator.vibrate(200);
      route();
    } catch (err) {
      if (err.status === 404) return expired();
      schedulePoll();
    }
  }

  function expired() {
    toast('Your order has expired. Please start again.');
    showStart();
  }

  // ---------- events ----------
  $('startForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('name').value.trim();
    const mobile = $('mobile').value.trim();
    if (name.length < 2) return toast('Please enter your name.'), $('name').focus();
    if (!/^\+?\d{10,15}$/.test(mobile.replace(/[\s()-]/g, ''))) return toast('Please enter a valid mobile number.'), $('mobile').focus();
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      order = await api('/api/orders', { method: 'POST', body: { name, mobile } });
      storage.set(KEYS.customer, { name, mobile });
      route();
    } catch (err) {
      toast(err.message);
      if (err.status === 429) showOpenOrders();
    } finally {
      button.disabled = false;
    }
  });

  $('editor').addEventListener('click', (event) => {
    if (event.target.id === 'editor') return closeEditor();
    const button = event.target.closest('.seg button');
    if (button) changeSetting(button.parentElement.dataset.setting, button.dataset.value);
  });
  $('copiesDown').onclick = () => changeSetting('copies', editing.settings.copies - 1);
  $('copiesUp').onclick = () => changeSetting('copies', editing.settings.copies + 1);
  $('rangeForm').addEventListener('submit', applyRange);
  $('edAll').onclick = applyToAll;
  $('edDone').onclick = () => closeEditor();
  $('edClose').onclick = () => closeEditor();
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && editing) closeEditor();
  });

  $('fileInput').addEventListener('change', (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    addFiles(event.dataTransfer.files);
  });

  $('reviewBtn').onclick = openReview;
  $('closeReview').onclick = () => { $('reviewSheet').hidden = true; };
  $('reviewSheet').addEventListener('click', (event) => { if (event.target.id === 'reviewSheet') event.target.hidden = true; });
  $('confirmBtn').onclick = confirmOrder;

  $('editOrder').onclick = async () => {
    try {
      order = await api(`/api/orders/${order.id}/edit`, { method: 'POST' });
      route();
    } catch (err) {
      toast(err.message);
    }
  };
  $('cancelOrder').onclick = async () => {
    if (!order || !window.confirm('Cancel this order and delete your files?')) return;
    try {
      await api(`/api/orders/${order.id}/cancel`, { method: 'POST' });
      uploads.length = 0;
      showStart();
    } catch (err) {
      toast(err.message);
    }
  };
  $('newOrder').onclick = async () => {
    const customer = { name: order.name, mobile: order.mobile };
    try {
      order = await api('/api/orders', { method: 'POST', body: customer });
      route();
    } catch (err) {
      toast(err.message);
      showStart();
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(pollTimer);
    else if (order) refresh();
  });

  // ---------- start ----------
  async function init() {
    try {
      info = await api('/api/info');
    } catch (_) {}
    document.title = info.shopName;
    $('shopName').textContent = info.shopName;
    $('fileInput').accept = info.accept;
    const types = info.accept.includes('.docx') ? 'PDF, photos, Word, Excel, PowerPoint' : 'PDF and photos';
    $('acceptHint').textContent = `${types} · up to ${info.limits.maxUploadMb} MB each`;
    $('colorOption').hidden = !info.options.color;
    $('sidesOption').hidden = !info.options.duplex;
    $('paperSeg').replaceChildren(...info.options.paperSizes.map((size) => {
      const button = el('button', '', size);
      button.type = 'button';
      button.dataset.value = size;
      return button;
    }));
    if (info.siteUrl) $('helpLine').textContent = `Upload not working? Open your browser and go to ${info.siteUrl}`;
    defaults = normalizeSettings(storage.get(KEYS.settings) || {});

    await restore();
  }

  // Reopens the order this phone was working on. It is only forgotten when the server says it no
  // longer exists; a dropped connection just retries, so a reload never loses an order.
  async function restore() {
    const saved = storage.get(KEYS.order);
    if (saved) {
      try {
        order = await api(`/api/orders/${saved}`);
      } catch (err) {
        if (err.status !== 404) {
          show('start');
          $('startForm').hidden = true;
          $('openOrders').hidden = true;
          $('fullNotice').textContent = 'Reconnecting to the print station…';
          $('fullNotice').hidden = false;
          $('startScreen').prepend($('fullNotice'));
          return setTimeout(restore, 3000);
        }
        storage.drop(KEYS.order);
      }
    }
    $('startForm').prepend($('fullNotice'));
    $('fullNotice').textContent = `The print station is full right now (${info.limits.maxCustomers} customers). Please try again in a few minutes.`;
    $('fullNotice').hidden = !info.full;
    if (order) return route();
    showStart(true);
  }
  init();
})();
