// Syntax-checks every JavaScript file in the project (used by `npm run build` and `npm test`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = ['index.js', ...['src', 'scripts', 'public', 'counter'].flatMap((dir) =>
  fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.js')).map((name) => path.join(dir, name)))];

for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
console.log(`Checked ${files.length} files.`);
