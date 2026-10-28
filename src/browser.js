import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

export async function ensureBrowser({ puppeteer, exists = existsSync, install, log = console.log } = {}) {
  puppeteer ||= (await import('puppeteer')).default;
  let browserPath;
  try { browserPath = await puppeteer.executablePath(); } catch { /* Missing browser cache. */ }
  if (browserPath && exists(browserPath)) return;
  log('\nDownloading the browser WhatBot needs. This may take a few minutes...');
  if (install) await install();
  else {
    // Execute the already-installed, pinned CLI; no npx package lookup or shell.
    const manifestPath = require.resolve('puppeteer/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.puppeteer;
    await new Promise((resolveInstall, reject) => {
      const child = spawn(process.execPath, [resolve(dirname(manifestPath), bin), 'browsers', 'install', 'chrome'], { stdio: 'inherit' });
      child.once('error', () => reject(new Error('Could not start the browser download. Run npm ci and try again.')));
      child.once('exit', code => code === 0 ? resolveInstall() : reject(new Error('Browser download failed. Check your connection, then restart WhatBot.')));
    });
  }
  browserPath = await puppeteer.executablePath();
  if (!browserPath || !exists(browserPath)) throw new Error('Browser is still missing. In the WhatBot folder, run: npx puppeteer browsers install chrome');
  log('Browser is ready.');
}
