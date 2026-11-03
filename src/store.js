const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// Orders are kept in memory and mirrored to tmp/orders.json, so a restart of the laptop
// does not lose customers who already have a PIN.
const stateFile = path.join(config.tmp, 'orders.json');
const orders = new Map();
const ACTIVE = new Set(['draft', 'waiting', 'queued', 'printing']);

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const temp = `${stateFile}.tmp`;
    fs.writeFile(temp, JSON.stringify([...orders.values()]), (err) => {
      if (err) return console.error('[store] Could not save orders:', err.message);
      fs.rename(temp, stateFile, () => {});
    });
  }, 300);
}

function orderDir(id) {
  return path.join(config.tmp, id);
}

function refreshExpiry(order) {
  const now = Date.now();
  if (order.status === 'draft') order.expiresAt = now + config.draftTtlMs;
  else if (order.status === 'waiting') order.expiresAt = (order.confirmedAt || now) + config.pinTtlMs;
  else if (order.status === 'queued' || order.status === 'printing') order.expiresAt = null;
  else order.expiresAt = (order.doneAt || now) + config.keepDoneMs;
}

function create(name, mobile, ip) {
  const order = {
    id: crypto.randomUUID(),
    name,
    mobile,
    ip,
    status: 'draft',
    pin: null,
    createdAt: Date.now(),
    confirmedAt: null,
    doneAt: null,
    expiresAt: null,
    files: [],
    totals: { files: 0, pages: 0, sheets: 0 },
    error: null,
  };
  refreshExpiry(order);
  fs.mkdirSync(orderDir(order.id), { recursive: true });
  orders.set(order.id, order);
  save();
  return order;
}

function get(id) {
  const order = orders.get(id);
  if (!order) return null;
  if (order.expiresAt && order.expiresAt <= Date.now()) {
    remove(id);
    return null;
  }
  return order;
}

function remove(id) {
  orders.delete(id);
  fs.rm(orderDir(id), { recursive: true, force: true }, () => {});
  save();
}

function setStatus(order, status, error = null) {
  order.status = status;
  order.error = error;
  if (status === 'waiting' && !order.confirmedAt) order.confirmedAt = Date.now();
  if (['printed', 'failed', 'rejected', 'cancelled'].includes(status)) order.doneAt = Date.now();
  refreshExpiry(order);
  save();
}

function activeCount(ip) {
  let count = 0;
  for (const order of orders.values()) if (ACTIVE.has(order.status) && (!ip || order.ip === ip)) count++;
  return count;
}

// Open orders started from one phone (its address on the hotspot), newest first. Lets a phone get
// back to its order when the browser forgot it (sign-in window, private tab, cleared storage).
function byDevice(ip) {
  return [...orders.values()]
    .filter((order) => order.ip === ip && ACTIVE.has(order.status) && get(order.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function newPin() {
  const taken = new Set([...orders.values()].map((order) => order.pin).filter(Boolean));
  if (taken.size >= 9000) throw new Error('Too many open orders. Please try again later.');
  let pin;
  do pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  while (taken.has(pin));
  return pin;
}

function findByPin(pin) {
  for (const order of orders.values()) if (order.pin === pin) return get(order.id);
  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSettings(input = {}) {
  return {
    copies: clamp(parseInt(input.copies, 10) || 1, 1, config.maxCopies),
    color: config.colorPrinting && input.color === 'color' ? 'color' : 'bw',
    sides: config.duplexPrinting && ['double-long', 'double-short'].includes(input.sides) ? input.sides : 'single',
    orientation: ['portrait', 'landscape'].includes(input.orientation) ? input.orientation : 'auto',
    paper: config.paperSizes.find((size) => size.toLowerCase() === String(input.paper || '').toLowerCase()) || config.paperSizes[0],
    scale: ['fit', 'shrink', 'noscale'].includes(input.scale) ? input.scale : 'fit',
  };
}

// Accepts "all" (or blank) or a list like "1-3, 5, 8-10". Returns the cleaned text and page count.
function parseRange(text, pages) {
  const value = String(text || '').replace(/\s+/g, '').toLowerCase();
  if (!value || value === 'all') return { range: 'all', count: pages };
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(value)) return { error: 'Use page numbers like 1-3,5' };
  const picked = new Set();
  for (const part of value.split(',')) {
    const [from, to = from] = part.split('-').map(Number);
    if (from < 1 || to < from || to > pages) return { error: `Pages must be between 1 and ${pages}` };
    for (let page = from; page <= to; page++) picked.add(page);
  }
  return { range: value, count: picked.size };
}

// Each file prints with its own settings, so totals add up file by file.
function computeTotals(order) {
  const totals = { files: 0, pages: 0, sheets: 0 };
  for (const file of order.files) {
    if (file.status !== 'ready') continue;
    const { copies, sides } = file.settings;
    const selected = parseRange(file.range, file.pages).count || 0;
    totals.files++;
    totals.pages += selected * copies;
    totals.sheets += (sides === 'single' ? selected : Math.ceil(selected / 2)) * copies;
  }
  order.totals = totals;
  return totals;
}

function fileView(file) {
  const selected = file.status === 'ready' ? parseRange(file.range, file.pages).count : null;
  return { id: file.id, name: file.name, kind: file.kind, size: file.size, pages: file.pages, range: file.range, selected, settings: file.settings || normalizeSettings(), status: file.status, error: file.error };
}

function publicView(order) {
  computeTotals(order);
  return {
    id: order.id,
    name: order.name,
    mobile: order.mobile,
    status: order.status,
    pin: order.status === 'draft' ? null : order.pin,
    files: order.files.map(fileView),
    totals: order.totals,
    confirmedAt: order.confirmedAt,
    expiresAt: order.expiresAt,
    error: order.error,
  };
}

function adminView(order) {
  return { ...publicView(order), pin: order.pin, createdAt: order.createdAt, doneAt: order.doneAt };
}

function recent(limit = 8) {
  return [...orders.values()]
    .filter((order) => ['queued', 'printing', 'printed', 'failed', 'rejected'].includes(order.status))
    .sort((a, b) => (b.doneAt || b.confirmedAt || 0) - (a.doneAt || a.confirmedAt || 0))
    .slice(0, limit)
    .map((order) => ({ id: order.id, name: order.name, status: order.status, pages: computeTotals(order).pages, at: order.doneAt || order.confirmedAt }));
}

function sweep() {
  const now = Date.now();
  for (const order of [...orders.values()]) if (order.expiresAt && order.expiresAt <= now) remove(order.id);
}

// Loads saved orders and removes anything on disk that no longer belongs to one.
// Returns files that were still being processed so the caller can queue them again.
function load() {
  fs.mkdirSync(path.join(config.tmp, 'incoming'), { recursive: true });
  try {
    for (const order of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) {
      if (order.status === 'queued' || order.status === 'printing') {
        order.status = 'waiting';
        order.error = 'Printing was interrupted by a restart. Check the printer before printing again.';
      }
      order.files = order.files.filter((file) => fs.existsSync(file.path));
      // Orders saved before settings moved to each file keep their one set of settings on every file.
      for (const file of order.files) file.settings = normalizeSettings(file.settings || order.settings);
      delete order.settings;
      orders.set(order.id, order);
      refreshExpiry(order);
      if (order.status === 'waiting') order.expiresAt = order.confirmedAt + config.pinTtlMs;
    }
  } catch (_) {}
  sweep();
  for (const entry of fs.readdirSync(config.tmp, { withFileTypes: true })) {
    const full = path.join(config.tmp, entry.name);
    if (entry.name === 'incoming') for (const file of fs.readdirSync(full)) fs.rmSync(path.join(full, file), { force: true });
    else if (entry.isDirectory() && !orders.has(entry.name)) fs.rmSync(full, { recursive: true, force: true });
  }
  save();
  const pending = [];
  for (const order of orders.values()) for (const file of order.files) if (file.status === 'processing') pending.push({ order, file });
  return pending;
}

module.exports = {
  orders,
  orderDir,
  create,
  get,
  remove,
  save,
  setStatus,
  refreshExpiry,
  activeCount,
  byDevice,
  newPin,
  findByPin,
  normalizeSettings,
  parseRange,
  computeTotals,
  publicView,
  adminView,
  recent,
  sweep,
  load,
};
