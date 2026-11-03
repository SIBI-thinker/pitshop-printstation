(() => {
  const $ = (id) => document.getElementById(id);
  const LABELS = {
    color: { bw: 'Black & white', color: 'Colour' },
    sides: { single: 'Single-sided', 'double-long': 'Double, long edge', 'double-short': 'Double, short edge' },
    orientation: { auto: 'Auto', portrait: 'Portrait', landscape: 'Landscape' },
    scale: { fit: 'Fit to page', shrink: 'Shrink only', noscale: 'Actual size' },
  };
  const STATUS = {
    draft: ['', 'Not confirmed'],
    waiting: ['warn', 'Waiting to print'],
    queued: ['info busy', 'Queued'],
    printing: ['info busy', 'Printing'],
    printed: ['ok', 'Printed'],
    failed: ['bad', 'Failed'],
    rejected: ['bad', 'Rejected'],
  };

  let pin = '';
  let current = null;
  let orderTimer = null;
  let backTimer = null;
  let qrShown = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let toastTimer;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
  }
  async function api(url, body) {
    const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  // ---------- header, QR and recent orders ----------
  async function overview() {
    try {
      const data = await api('/api/admin/overview');
      document.title = `${data.shopName} · Counter`;
      $('shopName').textContent = data.shopName;
      if (!qrShown) {
        $('wifiQr').src = data.wifiQr;
        qrShown = true;
      }
      $('ssid').textContent = data.ssid;
      $('password').textContent = data.password;
      $('siteUrl').textContent = data.siteUrl;
      const customers = $('customersPill');
      customers.className = `pill ${data.customers.active >= data.customers.max ? 'bad' : data.customers.active ? 'info' : ''}`;
      customers.textContent = `${data.customers.active}/${data.customers.max} customers${data.customers.active >= data.customers.max ? ' · full' : ''}`;
      const waiting = $('waitingPill');
      waiting.className = `pill ${data.waiting ? 'warn' : ''}`;
      waiting.textContent = `${data.waiting} waiting`;
      const printer = $('printerPill');
      printer.className = `pill ${data.printer.ready ? 'ok' : 'bad'}`;
      printer.textContent = `${data.printer.name} · ${data.printer.label}`;
      $('sumatraPill').hidden = Boolean(data.sumatra);
      const q = data.queue;
      $('queueText').textContent = q.current ? `Working: ${q.current}${q.printing + q.preparing ? ` · ${q.printing + q.preparing} more in queue` : ''}` : 'Queue idle';
      const recent = $('recent');
      recent.replaceChildren();
      if (!data.recent.length) recent.append(el('span', 'muted small', 'No orders yet'));
      for (const item of data.recent) {
        const row = el('div', 'recent-item');
        const [tone, label] = STATUS[item.status] || ['', item.status];
        row.append(el('span', `pill ${tone}`, label), el('strong', '', item.name), el('span', 'muted', `${plural(item.pages, 'page')} · ${time(item.at)}`));
        recent.append(row);
      }
    } catch (_) {
      $('printerPill').className = 'pill bad';
      $('printerPill').textContent = 'Server not reachable';
    }
  }

  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- PIN entry ----------
  function renderPin() {
    [...$('pinBoxes').children].forEach((box, index) => {
      box.textContent = pin[index] || '';
      box.classList.toggle('filled', index < pin.length);
    });
  }

  function press(key) {
    if (!$('orderView').hidden) return;
    $('pinError').textContent = '';
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (/^\d$/.test(key) && pin.length < 4) pin += key;
    renderPin();
    if (pin.length === 4) lookup();
  }

  async function lookup() {
    try {
      showOrder(await api('/api/admin/pin', { pin }));
    } catch (err) {
      $('pinError').textContent = err.message;
      const boxes = $('pinBoxes');
      boxes.classList.remove('shake');
      void boxes.offsetWidth;
      boxes.classList.add('shake');
      setTimeout(() => { pin = ''; renderPin(); }, 600);
    }
  }

  // ---------- order ----------
  function showOrder(order) {
    current = order;
    $('pinView').hidden = true;
    $('orderView').hidden = false;
    renderOrder();
  }

  function renderOrder() {
    const o = current;
    $('orderPin').textContent = o.pin;
    $('orderName').textContent = o.name;
    $('orderMobile').textContent = o.mobile;
    $('orderTime').textContent = o.confirmedAt ? `confirmed ${time(o.confirmedAt)}` : '';
    const [tone, label] = STATUS[o.status] || ['', o.status];
    $('orderStatus').className = `pill ${tone}`;
    $('orderStatus').textContent = label;

    $('orderFileCount').textContent = plural(o.files.length, 'file');
    $('orderFiles').replaceChildren(...o.files.map((file) => {
      const row = el('div', 'file');
      const ext = (file.name.split('.').pop() || '').toUpperCase();
      const url = `/api/admin/orders/${o.id}/files/${file.id}`;
      const source = { key: `counter-${file.id}`, kind: file.kind, size: file.size, url };
      const ready = file.status === 'ready';
      const s = file.settings;
      const icon = el(ready ? 'button' : 'div', `file-icon ${file.kind}`, ext.length <= 4 ? ext : 'FILE');
      if (ready) {
        icon.type = 'button';
        icon.onclick = () => preview(file, source);
        window.PrintPreview.thumb(icon, { file: source, range: file.range, settings: s, pages: file.pages });
      }
      row.append(icon);
      const main = el('div', 'file-main');
      main.append(el('div', 'file-name', file.name));
      const perCopy = s.sides === 'single' ? file.selected : Math.ceil(file.selected / 2);
      const picked = file.selected === file.pages ? plural(file.pages, 'page') : `Pages ${file.range} (${file.selected} of ${file.pages})`;
      main.append(el('div', 'file-meta', ready ? `${picked} · ${plural(perCopy * s.copies, 'sheet')}` : file.error || 'Not ready'));
      // Each file prints with its own settings, so they are shown on the file itself.
      const chips = el('div', 'file-settings');
      chips.append(...[LABELS.color[s.color], LABELS.sides[s.sides], LABELS.orientation[s.orientation], s.paper, LABELS.scale[s.scale], `${s.copies} ${s.copies === 1 ? 'copy' : 'copies'}`]
        .map((text) => el('span', `chip${(text === 'Colour' || /^\d+ copies$/.test(text)) ? ' strong' : ''}`, text)));
      main.append(chips);
      const actions = el('div', 'chips');
      const show = el('button', 'btn small', 'Preview');
      show.type = 'button';
      show.disabled = !ready;
      show.onclick = () => preview(file, source);
      const open = el('a', 'btn small ghost', 'Open');
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener';
      actions.append(show, open);
      row.append(main, actions);
      return row;
    }));

    $('orderPages').textContent = o.totals.pages;
    $('orderSheets').textContent = o.totals.sheets;
    $('orderFileTotal').textContent = o.totals.files;

    const notice = $('orderNotice');
    notice.hidden = !o.error && o.status !== 'printed';
    notice.className = `notice ${o.status === 'printed' ? '' : o.status === 'waiting' ? 'warn' : 'bad'}`;
    notice.textContent = o.status === 'printed' ? 'Printed. Hand the pages to the customer.' : o.error || '';

    const printBtn = $('printBtn');
    const busy = ['queued', 'printing'].includes(o.status);
    printBtn.hidden = ['rejected', 'draft'].includes(o.status);
    printBtn.disabled = busy;
    printBtn.textContent = busy ? 'Printing…' : o.status === 'failed' ? 'Try again' : o.status === 'printed' ? 'Print again' : `Print now · ${plural(o.totals.pages, 'page')}`;
    $('rejectBtn').hidden = !['waiting', 'failed'].includes(o.status);
    $('backBtn').firstChild.textContent = ['printed', 'rejected'].includes(o.status) ? 'Next customer ' : 'Back to PIN entry ';

    clearTimeout(orderTimer);
    if (busy) orderTimer = setTimeout(refreshOrder, 2000);
    clearTimeout(backTimer);
    if (['printed', 'rejected'].includes(o.status)) backTimer = setTimeout(back, 20000);
  }

  function preview(file, source) {
    const s = file.settings;
    const perCopy = s.sides === 'single' ? file.selected : Math.ceil(file.selected / 2);
    window.PrintPreview.open({
      title: `${current.name} · ${file.name}`,
      subtitle: `${plural(perCopy, 'sheet')} per copy · ${plural(file.selected * s.copies, 'page')} in total`,
      file: source,
      pages: file.pages,
      range: file.range,
      settings: s,
      chips: [LABELS.color[s.color], LABELS.sides[s.sides], LABELS.orientation[s.orientation], s.paper, LABELS.scale[s.scale], `${s.copies} ${s.copies === 1 ? 'copy' : 'copies'}`],
    });
  }

  async function refreshOrder() {
    if (!current) return;
    try {
      const before = current.status;
      current = await api(`/api/admin/orders/${current.id}`);
      renderOrder();
      if (before !== current.status) overview();
    } catch (err) {
      toast(err.message);
      back();
    }
  }

  async function act(action) {
    try {
      current = await api(`/api/admin/orders/${current.id}/${action}`, {});
      renderOrder();
      overview();
    } catch (err) {
      toast(err.message);
    }
  }

  function back() {
    clearTimeout(orderTimer);
    clearTimeout(backTimer);
    current = null;
    pin = '';
    renderPin();
    $('pinError').textContent = '';
    $('orderView').hidden = true;
    $('pinView').hidden = false;
    overview();
  }

  // ---------- events ----------
  $('keypad').addEventListener('click', (event) => {
    const key = event.target.closest('button')?.dataset.key;
    if (key) press(key);
  });
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (!$('orderView').hidden) {
      if (event.key === 'Escape') back();
      return;
    }
    if (/^\d$/.test(event.key)) press(event.key);
    else if (event.key === 'Backspace') press('back');
    else if (event.key === 'Escape') press('clear');
  });
  $('printBtn').onclick = () => {
    if (current.status === 'printed' && !window.confirm('This order was already printed. Print it again?')) return;
    act('print');
  };
  $('rejectBtn').onclick = () => {
    if (window.confirm(`Reject the order from ${current.name}? It will not be printed.`)) act('reject');
  };
  $('backBtn').onclick = back;

  tick();
  setInterval(tick, 10000);
  overview();
  setInterval(() => { if (!document.hidden) overview(); }, 10000);
})();
