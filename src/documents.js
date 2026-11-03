const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const config = require('./config');

const KINDS = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.doc': 'office',
  '.docx': 'office',
  '.xls': 'office',
  '.xlsx': 'office',
  '.ppt': 'office',
  '.pptx': 'office',
};

function kindOf(filename) {
  const kind = KINDS[path.extname(filename).toLowerCase()];
  if (kind === 'office' && !config.allowOffice) return null;
  return kind || null;
}

function acceptList() {
  return Object.keys(KINDS).filter((ext) => kindOf(`x${ext}`)).join(',');
}

function run(command, args, timeout = 180000) {
  return new Promise((resolve) => execFile(command, args, { windowsHide: true, timeout }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

function failure(result) {
  return result.error ? (result.stderr.trim() || result.error.message) : null;
}

// pdf-lib parses in small slices (its default speed), so a big PDF does not freeze the server.
async function countPdfPages(file) {
  const bytes = await fs.promises.readFile(file);
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    return pdf.getPageCount();
  } catch (err) {
    // Fallback for damaged files: count page objects directly.
    const matches = bytes.toString('latin1').match(/\/Type\s*\/Page(?!s)/g);
    if (matches && matches.length) return matches.length;
    throw new Error('This PDF could not be read. It may be damaged or password protected.');
  }
}

async function convertOffice(file) {
  const dir = path.dirname(file);
  const pdf = path.join(dir, `${path.basename(file, path.extname(file))}.pdf`);
  let result;
  if (config.conversion === 'libreoffice') {
    if (!fs.existsSync(config.libreoffice)) throw new Error(`LibreOffice was not found at ${config.libreoffice}.`);
    result = await run(config.libreoffice, ['--headless', '--convert-to', 'pdf', '--outdir', dir, file]);
  } else {
    const script = path.join(config.root, 'scripts', 'convert-office.ps1');
    result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputPath', file, '-OutputDir', dir]);
  }
  if (!fs.existsSync(pdf)) throw new Error(failure(result) || 'The document could not be converted to PDF.');
  return pdf;
}

// Turns an uploaded file into something printable and returns its page count.
async function prepare(file) {
  if (file.kind === 'image') return { pages: 1, printPath: file.path };
  const printPath = file.kind === 'office' ? await convertOffice(file.path) : file.path;
  return { pages: await countPdfPages(printPath), printPath };
}

function printSettings(settings, range) {
  const parts = [];
  if (range && range !== 'all') parts.push(range);
  parts.push(`${settings.copies}x`);
  if (settings.copies > 1) parts.push('collate');
  parts.push(settings.color === 'color' ? 'color' : 'monochrome');
  parts.push({ single: 'simplex', 'double-long': 'duplexlong', 'double-short': 'duplexshort' }[settings.sides] || 'simplex');
  if (settings.orientation !== 'auto') parts.push(settings.orientation);
  parts.push(`paper=${settings.paper}`, settings.scale);
  return parts.join(',');
}

const SUMATRA_ERRORS = {
  2: 'The file could not be opened.',
  3: 'This document does not allow printing.',
  4: 'The printer was not found.',
  5: 'The printer driver reported an error.',
};

// SumatraPDF installs per user (AppData\Local) by default, or system-wide, or runs as a portable
// copy; look in SUMATRA_PATH first, then the usual places and PATH. Checked again each minute,
// so installing it does not need a restart.
let sumatraCache = { at: 0, path: null };
function sumatraCandidates() {
  const env = process.env;
  return [
    config.sumatra,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'SumatraPDF', 'SumatraPDF.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'SumatraPDF', 'SumatraPDF.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(config.root, 'tools', 'SumatraPDF.exe'),
    ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'SumatraPDF.exe')),
  ].filter(Boolean);
}
function findSumatra() {
  if (Date.now() - sumatraCache.at < 60000) return sumatraCache.path;
  sumatraCache = { at: Date.now(), path: sumatraCandidates().find((candidate) => fs.existsSync(candidate)) || null };
  return sumatraCache.path;
}

async function printFile(printPath, settings, range) {
  const sumatra = findSumatra();
  if (!sumatra) throw new Error('SumatraPDF was not found. Install it from sumatrapdfreader.org, or set SUMATRA_PATH in .env to where SumatraPDF.exe is.');
  const args = config.printer ? ['-print-to', config.printer] : ['-print-to-default'];
  args.push('-silent', '-print-settings', printSettings(settings, range), printPath);
  const result = await run(sumatra, args, 300000);
  if (result.error) throw new Error(SUMATRA_ERRORS[result.error.code] || failure(result));
}

// Printer status needs a PowerShell call, which is slow on a weak laptop, so it is cached.
let printerCache = { at: 0, value: null };
async function printerStatus() {
  if (Date.now() - printerCache.at < 60000 && printerCache.value) return printerCache.value;
  const filter = config.printer ? `Name -eq '${config.printer.replace(/'/g, "''")}'` : 'Default -eq $true';
  const script = `$p = Get-CimInstance Win32_Printer | Where-Object { $_.${filter} } | Select-Object -First 1; if ($p) { @{ name = $p.Name; offline = [bool]$p.WorkOffline; status = [int]$p.PrinterStatus } | ConvertTo-Json -Compress }`;
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 20000);
  let value = { name: config.printer || 'No default printer', ready: false, label: 'Not found' };
  try {
    const info = JSON.parse(result.stdout);
    // Win32_Printer PrinterStatus: 3 idle, 4 printing, 5 warming up; 1 and 2 are reported by many drivers when idle too.
    const ready = !info.offline && [1, 2, 3, 4, 5].includes(info.status);
    value = { name: info.name, ready, label: info.offline ? 'Offline' : info.status === 4 ? 'Printing' : ready ? 'Ready' : 'Needs attention' };
  } catch (_) {}
  printerCache = { at: Date.now(), value };
  return value;
}

module.exports = { kindOf, acceptList, prepare, printFile, printSettings, printerStatus, findSumatra };
