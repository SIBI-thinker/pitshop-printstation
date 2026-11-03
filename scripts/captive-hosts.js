// Adds (or with --remove, removes) the captive-portal entries in the Windows hosts file.
// Needs an Administrator prompt. Run once on the print station: node scripts/captive-hosts.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { PROBE_HOSTS } = require('../src/captive');

const hostsFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
const START = '# >>> print-station captive portal';
const END = '# <<< print-station captive portal';

const current = fs.readFileSync(hostsFile, 'utf8');
const cleaned = current.replace(new RegExp(`\\r?\\n?${START}[\\s\\S]*?${END}\\r?\\n?`), '\r\n').replace(/(\r?\n)+$/, '');
const block = [START, ...PROBE_HOSTS.map((host) => `${config.gateway} ${host}`), END].join('\r\n');
const next = process.argv.includes('--remove') ? `${cleaned}\r\n` : `${cleaned}\r\n\r\n${block}\r\n`;

try {
  fs.writeFileSync(hostsFile, next);
  console.log(process.argv.includes('--remove') ? 'Captive portal entries removed.' : `Captive portal entries added for ${config.gateway}.`);
} catch (err) {
  console.error(`Could not update ${hostsFile}. Run this from an Administrator prompt.`);
  process.exitCode = 1;
}
