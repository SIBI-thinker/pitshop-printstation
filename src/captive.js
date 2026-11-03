const config = require('./config');

// Hosts that phones fetch over plain HTTP right after joining Wi-Fi to check for internet.
// scripts/captive-hosts.js points them at the laptop in the Windows hosts file; the Mobile Hotspot
// DNS answers from that file, so the phone's check reaches this server. Hosts the laptop itself
// relies on (Windows, www.google.com) are left out.
const PROBE_HOSTS = [
  'connectivitycheck.gstatic.com',
  'connectivitycheck.android.com',
  'clients1.google.com',
  'clients3.google.com',
  'captive.apple.com',
  'www.appleiphonecell.com',
  'www.ibook.info',
  'www.itools.info',
  'www.airport.us',
  'www.thinkdifferent.us',
  'connect.rom.miui.com',
  'connectivitycheck.platform.hicloud.com',
  'detectportal.firefox.com',
  'nmcheck.gnome.org',
];

// Phones that have reached the print site. Until a phone is on this list its internet check is
// redirected, so it shows the "Sign in to network" window. Afterwards the check gets the normal
// "online" answer: the phone then treats the Wi-Fi as working and stops sending the browser's
// traffic (and uploads) over mobile data.
const CONNECTED_MS = 3 * 60 * 60 * 1000;
const connected = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, until] of connected) if (until < now) connected.delete(ip);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function markConnected(req) {
  connected.set(clientIp(req), Date.now() + CONNECTED_MS);
}

function isConnected(req) {
  return (connected.get(clientIp(req)) || 0) > Date.now();
}

function localAddress(req) {
  return String(req.socket.localAddress || config.gateway).replace(/^::ffff:/, '');
}

function siteUrl(req) {
  const host = localAddress(req);
  const shown = host === '127.0.0.1' || host === '::1' ? config.gateway : host;
  return `http://${shown}${config.port === 80 ? '' : `:${config.port}`}/`;
}

// The answer each platform expects when the internet is reachable.
function onlineAnswer(req, res) {
  const host = req.hostname;
  if (/apple|ibook|itools|airport|thinkdifferent/.test(host)) {
    return res.type('html').send('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>');
  }
  if (host === 'detectportal.firefox.com') return res.type('text/plain').send('success\n');
  if (host === 'nmcheck.gnome.org') return res.type('text/plain').send('NetworkManager is online\n');
  res.status(204).end();
}

// Requests with a domain name instead of our IP came through the hosts redirect: they are internet checks.
function middleware(req, res, next) {
  const host = req.hostname || '';
  if (!config.captivePortal) return next();
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) {
    // Any use of the customer API means the phone has the site open.
    if (req.path.startsWith('/api/') && !req.path.startsWith('/api/admin')) markConnected(req);
    return next();
  }
  if (isConnected(req)) return onlineAnswer(req, res);
  res.set('Cache-Control', 'no-store').redirect(302, `${siteUrl(req)}welcome`);
}

function isLocal(req) {
  const address = String(req.socket.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function localOnly(req, res, next) {
  if (isLocal(req)) return next();
  res.status(403).json({ error: 'This page is only available on the print station.' });
}

module.exports = { PROBE_HOSTS, middleware, siteUrl, localOnly };
