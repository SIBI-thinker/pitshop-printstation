const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');

// Turns on Windows Mobile Hotspot with the configured name and password.
function start() {
  if (process.platform !== 'win32' || !config.hotspotAutostart) return;
  const script = path.join(config.root, 'scripts', 'hotspot.ps1');
  // WinRT tethering APIs only exist in Windows PowerShell 5.1 (powershell.exe), not PowerShell 7.
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Ssid', config.ssid, '-Password', config.password], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
    const message = String(stdout || '').trim() || String(stderr || '').trim();
    if (error) console.error(`[hotspot] Could not start the hotspot: ${message || error.message}\n[hotspot] Turn on Mobile Hotspot in Windows Settings instead.`);
    else console.log(`[hotspot] ${message}`);
  });
}

module.exports = { start };
