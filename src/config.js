const path = require('path');

const env = process.env;
const num = (name, fallback, min = 0) => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
};
const bool = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : /^(1|true|yes|on)$/i.test(env[name]));
const list = (name, fallback) => (env[name] || fallback).split(',').map((item) => item.trim()).filter(Boolean);

const root = path.join(__dirname, '..');

module.exports = {
  root,
  // Uploaded files and the saved order list. Give a second copy of the server its own folder.
  tmp: path.resolve(root, env.STORAGE_DIR || 'tmp'),
  shopName: env.SHOP_NAME || 'Print Station',
  port: num('SERVER_PORT', 80, 1),

  // Hotspot and captive portal
  ssid: env.HOTSPOT_SSID || 'PrintStation',
  password: env.HOTSPOT_PASSWORD || 'PrintNow2024',
  gateway: env.HOTSPOT_GATEWAY || '192.168.137.1',
  hotspotAutostart: bool('HOTSPOT_AUTOSTART', true),
  captivePortal: bool('CAPTIVE_PORTAL', true),

  // Limits, kept small so a low-spec laptop stays responsive
  maxUploadMb: num('MAX_UPLOAD_MB', 20, 1),
  maxFilesPerOrder: num('MAX_FILES_PER_ORDER', 10, 1),
  maxPagesPerOrder: num('MAX_PAGES_PER_ORDER', 300, 1),
  // Customers served at once (filling in an order, waiting with a PIN, or printing), in any order.
  maxActiveOrders: num('MAX_ACTIVE_ORDERS', 10, 1),
  maxOrdersPerDevice: num('MAX_ORDERS_PER_DEVICE', 3, 1),
  maxCopies: num('MAX_COPIES', 20, 1),
  draftTtlMs: num('DRAFT_TTL_MINUTES', 30, 1) * 60000,
  pinTtlMs: num('PIN_TTL_MINUTES', 120, 1) * 60000,
  keepDoneMs: num('KEEP_DONE_MINUTES', 15, 1) * 60000,

  // Printer capabilities shown to customers
  allowOffice: bool('ALLOW_OFFICE', true),
  colorPrinting: bool('COLOR_PRINTING', true),
  duplexPrinting: bool('DUPLEX_PRINTING', true),
  paperSizes: list('PAPER_SIZES', 'A4,A3,A5,Letter,Legal'),

  // Tools
  printer: env.PRINTER_NAME || '',
  sumatra: env.SUMATRA_PATH || 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
  conversion: (env.CONVERSION_METHOD || 'interop').toLowerCase(),
  libreoffice: env.LIBREOFFICE_PATH || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
};
