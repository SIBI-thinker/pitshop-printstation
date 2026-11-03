const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const taskName = 'ScanToPrintWorkstation';

if (process.platform !== 'win32') {
  console.log('Windows installation is required for hotspot, Office, and printer integration.');
  process.exit(0);
}

try {
  // Start the print station when Windows starts.
  execFileSync('schtasks', [
    '/Create', '/TN', taskName,
    '/TR', `"${process.execPath}" "${path.join(root, 'index.js')}"`,
    '/SC', 'ONSTART', '/RL', 'HIGHEST', '/F',
  ], { stdio: 'inherit' });

  // Older versions also scheduled a separate purge task; the server now cleans up by itself.
  try { execFileSync('schtasks', ['/Delete', '/TN', `${taskName}-Purge`, '/F'], { stdio: 'ignore' }); } catch (_) {}

  console.log('Startup task installed.');
  console.log(`Project: ${root}`);
} catch (err) {
  console.error('Installation failed. Run this command as Administrator.');
  process.exitCode = 1;
}
