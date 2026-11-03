const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');
const store = require('./store');
const queue = require('./queue');
const documents = require('./documents');
const captive = require('./captive');
const hotspot = require('./hotspot');

const app = express();
app.disable('x-powered-by');
const incoming = path.join(config.tmp, 'incoming');

// ---------- helpers ----------

function fail(res, code, error) {
  return res.status(code).json({ error });
}

function parseJson(text) {
  try {
    return JSON.parse(text || '{}') || {};
  } catch (_) {
    return {};
  }
}

// A small per-device request budget keeps one phone from swamping a weak laptop.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  let entry = hits.get(req.ip);
  if (!entry || entry.reset < now) hits.set(req.ip, (entry = { count: 0, reset: now + 60000 }));
  if (++entry.count > 120) return fail(res, 429, 'Too many requests. Please wait a moment.');
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.reset < now) hits.delete(ip);
  store.sweep();
}, 60000).unref();

function draftOrder(req, res) {
  const order = store.get(req.params.id);
  if (!order) return fail(res, 404, 'This order has expired. Please start again.'), null;
  if (order.status !== 'draft') return fail(res, 409, 'This order is already confirmed.'), null;
  store.refreshExpiry(order);
  return order;
}

function deleteFile(file) {
  for (const target of new Set([file.path, file.printPath].filter(Boolean))) fs.rm(target, { force: true }, () => {});
}

function queuePrepare(order, file) {
  queue.add('prepare', `prepare ${file.name}`, async () => {
    if (!store.get(order.id) || !order.files.includes(file)) return;
    try {
      Object.assign(file, await documents.prepare(file), { status: 'ready' });
    } catch (err) {
      Object.assign(file, { status: 'error', error: err.message });
    }
    store.save();
  });
}

function queuePrint(order) {
  store.setStatus(order, 'queued');
  queue.add('print', `print ${order.pin}`, async () => {
    if (!store.get(order.id) || order.status !== 'queued') return;
    store.setStatus(order, 'printing');
    try {
      for (const file of order.files) if (file.status === 'ready') await documents.printFile(file.printPath, file.settings, file.range);
      store.setStatus(order, 'printed');
    } catch (err) {
      store.setStatus(order, 'failed', err.message);
    }
  });
}

// ---------- app ----------

app.use(captive.middleware);
app.use(express.json({ limit: '10kb' }));
app.use('/counter', captive.localOnly, express.static(path.join(config.root, 'counter')));
// pdf.js draws page previews in the phone's or counter's browser, so the laptop never renders pages itself.
app.use('/vendor/pdfjs', express.static(path.join(config.root, 'node_modules', 'pdfjs-dist', 'legacy', 'build'), { maxAge: '7d' }));
app.use(express.static(path.join(config.root, 'public')));

// ---------- customer API ----------

const customer = express.Router();
customer.use(rateLimit);

customer.get('/info', (req, res) => {
  res.json({
    shopName: config.shopName,
    accept: documents.acceptList(),
    siteUrl: captive.siteUrl(req),
    full: store.activeCount() >= config.maxActiveOrders,
    limits: { maxCustomers: config.maxActiveOrders, maxUploadMb: config.maxUploadMb, maxFiles: config.maxFilesPerOrder, maxPages: config.maxPagesPerOrder, maxCopies: config.maxCopies },
    options: { color: config.colorPrinting, duplex: config.duplexPrinting, paperSizes: config.paperSizes },
  });
});

// Called by the welcome page's Continue button; the captive middleware has already marked the phone as connected.
customer.post('/connect', (req, res) => res.json({ ok: true, siteUrl: captive.siteUrl(req) }));

customer.post('/orders', (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  const mobile = String(req.body?.mobile || '').replace(/[\s()-]/g, '');
  if (name.length < 2) return fail(res, 400, 'Please enter your name.');
  if (!/^\+?\d{10,15}$/.test(mobile)) return fail(res, 400, 'Please enter a valid mobile number.');
  // Starting again from the same phone reuses its empty draft instead of opening another order.
  const emptyDraft = store.byDevice(req.ip).find((order) => order.status === 'draft' && !order.files.length);
  if (emptyDraft) {
    Object.assign(emptyDraft, { name, mobile });
    store.refreshExpiry(emptyDraft);
    store.save();
    return res.json(store.publicView(emptyDraft));
  }
  if (store.activeCount() >= config.maxActiveOrders) return fail(res, 503, `The print station is full right now (${config.maxActiveOrders} customers). Please try again in a few minutes.`);
  if (store.activeCount(req.ip) >= config.maxOrdersPerDevice) return fail(res, 429, 'You already have open orders on this phone. Continue one of them, or cancel it to start a new one.');
  res.json(store.publicView(store.create(name, mobile, req.ip)));
});

// This phone's open orders, so it can pick up where it left off.
customer.get('/orders/mine', (req, res) => {
  res.json({
    orders: store.byDevice(req.ip).map((order) => ({
      id: order.id,
      name: order.name,
      status: order.status,
      files: order.files.length,
      pin: order.status === 'draft' ? null : order.pin,
      createdAt: order.createdAt,
    })),
  });
});

customer.get('/orders/:id', (req, res) => {
  const order = store.get(req.params.id);
  if (!order) return fail(res, 404, 'This order has expired. Please start again.');
  if (order.status === 'draft') store.refreshExpiry(order);
  res.json(store.publicView(order));
});

const upload = multer({
  storage: multer.diskStorage({
    destination: incoming,
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  // Browsers send file names as UTF-8; multer would otherwise read them as Latin-1 and garble Tamil, Hindi, etc.
  defParamCharset: 'utf8',
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (req, file, cb) => cb(null, Boolean(documents.kindOf(file.originalname))),
});

customer.post('/orders/:id/files', upload.single('file'), (req, res) => {
  const discard = () => req.file && fs.rm(req.file.path, { force: true }, () => {});
  const order = draftOrder(req, res);
  if (!order) return discard();
  if (!req.file) return fail(res, 400, 'This file type is not supported.');
  if (order.files.length >= config.maxFilesPerOrder) return discard(), fail(res, 400, `You can add up to ${config.maxFilesPerOrder} files.`);
  const target = path.join(store.orderDir(order.id), req.file.filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(req.file.path, target);
  const file = {
    id: crypto.randomUUID(),
    name: path.basename(req.file.originalname).slice(-120),
    kind: documents.kindOf(req.file.originalname),
    size: req.file.size,
    path: target,
    printPath: null,
    pages: null,
    range: 'all',
    // The phone sends the settings the customer used last, so new files start the same way.
    settings: store.normalizeSettings(parseJson(req.body?.settings)),
    status: 'processing',
    error: null,
  };
  order.files.push(file);
  store.save();
  queuePrepare(order, file);
  res.json(store.publicView(order));
});

// The printable version of a file (the PDF for Office documents), for the page preview.
customer.get('/orders/:id/files/:fileId', (req, res) => {
  const order = store.get(req.params.id);
  const file = order && order.files.find((item) => item.id === req.params.fileId);
  if (!file || file.status !== 'ready') return fail(res, 404, 'File not found.');
  res.set('Cache-Control', 'private, max-age=600').sendFile(file.printPath || file.path);
});

// Changes one file's page range and/or print settings.
customer.patch('/orders/:id/files/:fileId', (req, res) => {
  const order = draftOrder(req, res);
  if (!order) return;
  const file = order.files.find((item) => item.id === req.params.fileId);
  if (!file) return fail(res, 404, 'File not found.');
  if (req.body?.range !== undefined) {
    if (file.status !== 'ready') return fail(res, 409, 'This file is still being prepared.');
    const parsed = store.parseRange(req.body.range, file.pages);
    if (parsed.error) return fail(res, 400, parsed.error);
    file.range = parsed.range;
  }
  if (req.body?.settings) file.settings = store.normalizeSettings({ ...file.settings, ...req.body.settings });
  store.save();
  res.json(store.publicView(order));
});

// "Use for all files": copies one set of print settings to every file (page ranges stay per file).
customer.patch('/orders/:id/files', (req, res) => {
  const order = draftOrder(req, res);
  if (!order) return;
  const settings = store.normalizeSettings(req.body?.settings);
  for (const file of order.files) file.settings = { ...settings };
  store.save();
  res.json(store.publicView(order));
});

customer.delete('/orders/:id/files/:fileId', (req, res) => {
  const order = draftOrder(req, res);
  if (!order) return;
  const index = order.files.findIndex((item) => item.id === req.params.fileId);
  if (index === -1) return fail(res, 404, 'File not found.');
  deleteFile(order.files.splice(index, 1)[0]);
  store.save();
  res.json(store.publicView(order));
});

customer.post('/orders/:id/confirm', (req, res) => {
  const order = draftOrder(req, res);
  if (!order) return;
  if (!order.files.length) return fail(res, 400, 'Add at least one file.');
  if (order.files.some((file) => file.status === 'processing')) return fail(res, 409, 'Your files are still being prepared.');
  if (order.files.some((file) => file.status === 'error')) return fail(res, 400, 'Remove the files that could not be read.');
  const totals = store.computeTotals(order);
  if (totals.pages > config.maxPagesPerOrder) return fail(res, 400, `Orders are limited to ${config.maxPagesPerOrder} printed pages.`);
  try {
    order.pin = store.newPin();
  } catch (err) {
    return fail(res, 503, err.message);
  }
  store.setStatus(order, 'waiting');
  res.json(store.publicView(order));
});

customer.post('/orders/:id/edit', (req, res) => {
  const order = store.get(req.params.id);
  if (!order) return fail(res, 404, 'This order has expired. Please start again.');
  if (order.status !== 'waiting') return fail(res, 409, 'This order can no longer be changed.');
  order.pin = null;
  order.confirmedAt = null;
  store.setStatus(order, 'draft');
  res.json(store.publicView(order));
});

customer.post('/orders/:id/cancel', (req, res) => {
  const order = store.get(req.params.id);
  if (order && ['queued', 'printing'].includes(order.status)) return fail(res, 409, 'This order is already printing.');
  if (order) store.remove(order.id);
  res.json({ ok: true });
});

app.use('/api', customer);

// ---------- counter (laptop) API ----------

const counter = express.Router();
counter.use(captive.localOnly);

let wifiQr = null;
counter.get('/overview', async (req, res) => {
  const escape = (value) => value.replace(/([\\;,:"])/g, '\\$1');
  wifiQr = wifiQr || (await QRCode.toDataURL(`WIFI:T:WPA;S:${escape(config.ssid)};P:${escape(config.password)};;`, { width: 520, margin: 1, errorCorrectionLevel: 'M' }));
  let waiting = 0;
  for (const order of store.orders.values()) if (order.status === 'waiting') waiting++;
  res.json({
    shopName: config.shopName,
    ssid: config.ssid,
    password: config.password,
    siteUrl: captive.siteUrl(req),
    wifiQr,
    printer: await documents.printerStatus(),
    sumatra: documents.findSumatra(),
    waiting,
    customers: { active: store.activeCount(), max: config.maxActiveOrders },
    queue: queue.status(),
    recent: store.recent(),
  });
});

counter.post('/pin', (req, res) => {
  const pin = String(req.body?.pin || '');
  const order = /^\d{4}$/.test(pin) ? store.findByPin(pin) : null;
  if (!order || order.status === 'draft') return fail(res, 404, 'No order found with this PIN.');
  res.json(store.adminView(order));
});

function counterOrder(req, res) {
  const order = store.get(req.params.id);
  if (!order) return fail(res, 404, 'This order no longer exists.'), null;
  return order;
}

counter.get('/orders/:id', (req, res) => {
  const order = counterOrder(req, res);
  if (order) res.json(store.adminView(order));
});

counter.post('/orders/:id/print', (req, res) => {
  const order = counterOrder(req, res);
  if (!order) return;
  if (!['waiting', 'failed', 'printed'].includes(order.status)) return fail(res, 409, 'This order is already printing.');
  queuePrint(order);
  res.json(store.adminView(order));
});

counter.post('/orders/:id/reject', (req, res) => {
  const order = counterOrder(req, res);
  if (!order) return;
  if (!['waiting', 'failed'].includes(order.status)) return fail(res, 409, 'This order cannot be rejected now.');
  store.setStatus(order, 'rejected', 'The order was declined at the counter.');
  res.json(store.adminView(order));
});

counter.get('/orders/:id/files/:fileId', (req, res) => {
  const order = counterOrder(req, res);
  if (!order) return;
  const file = order.files.find((item) => item.id === req.params.fileId);
  if (!file) return fail(res, 404, 'File not found.');
  res.sendFile(file.printPath || file.path, { headers: { 'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"` } });
});

app.use('/api/admin', counter);

// ---------- fallbacks ----------

app.use('/api', (req, res) => fail(res, 404, 'Not found.'));
const welcomePage = fs.readFileSync(path.join(config.root, 'public', 'welcome.html'), 'utf8');
const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
app.get('/welcome', (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(welcomePage.replaceAll('%SHOP_NAME%', escapeHtml(config.shopName)).replaceAll('%SITE_URL%', escapeHtml(captive.siteUrl(req))));
});
app.get('/{*splat}', (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));
app.use((err, req, res, next) => {
  if (req.file) fs.rm(req.file.path, { force: true }, () => {});
  if (err instanceof multer.MulterError) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? `Files must be smaller than ${config.maxUploadMb} MB.` : 'The upload could not be read.');
  console.error('[server]', err);
  fail(res, err.status || 500, err.expose ? err.message : 'Something went wrong.');
});

// ---------- start ----------

for (const { order, file } of store.load()) queuePrepare(order, file);

app.listen(config.port, '0.0.0.0', () => {
  const port = config.port === 80 ? '' : `:${config.port}`;
  console.log(`${config.shopName} is running.`);
  console.log(`  Counter screen: http://localhost${port}/counter/`);
  console.log(`  Customers:      http://${config.gateway}${port}/  (Wi-Fi "${config.ssid}")`);
  hotspot.start();
}).on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Close the other program or change SERVER_PORT.` : err.message);
  process.exit(1);
});
