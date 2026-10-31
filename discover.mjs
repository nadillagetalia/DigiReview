import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const target = process.env.DIGIREVIEW_URL ||
  'https://digireview.id/approver/project/106021/template/32120?dokumen=100012';
const origin = new URL(target).origin;
const probe = process.argv.includes('--probe');
const privateDir = new URL('./private/', import.meta.url);
const statePath = new URL('session.json', privateDir);
const reportPath = new URL(probe ? 'probe.json' : 'endpoints.json', privateDir);

// Keep response values, credentials, cookies and authorization headers out of reports.
function safeUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|password|auth|session|signature|key|code|email/i.test(key)) {
      url.searchParams.set(key, '[REDACTED]');
    }
  }
  return url.href;
}

function jsonShape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length,
      item: depth < 4 && value.length ? jsonShape(value[0], depth + 1) : undefined };
  }
  if (typeof value === 'object') {
    if (depth >= 4) return 'object';
    return Object.fromEntries(Object.entries(value).slice(0, 50)
      .map(([key, child]) => [key, jsonShape(child, depth + 1)]));
  }
  return typeof value;
}

await mkdir(privateDir, { recursive: true });
let storageState;
try {
  storageState = JSON.parse(await readFile(statePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const browser = await chromium.launch({ headless: probe });
const context = await browser.newContext({ storageState });
const records = new Map();
const documents = [];
const pending = new Set();

async function recordResponse(response) {
  const request = response.request();
  if (new URL(response.url()).origin !== origin) return;
  if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()) {
    documents.push({ url: safeUrl(response.url()), status: response.status() });
  }
  if (!['fetch', 'xhr'].includes(request.resourceType())) return;
  // Login submissions can contain credentials; only inspect their metadata.
  const url = safeUrl(response.url());
  const key = `${request.method()} ${url}`;
  const previous = records.get(key);
  const entry = {
    method: request.method(), url, status: response.status(),
    contentType: response.headers()['content-type'] || '',
    count: (previous?.count || 0) + 1,
    possibleNotification: /notif|notification|unread|pemberitahuan|bell/i.test(url),
  };
  records.set(key, entry);
  if (/json/i.test(entry.contentType) && !/login|auth|token|password/i.test(new URL(url).pathname)) {
    try {
      const body = await response.json();
      entry.responseShape = jsonShape(body);
      entry.possibleNotification ||= /notif|notification|unread|pemberitahuan/i
        .test(JSON.stringify(entry.responseShape));
    } catch {
      entry.responseShape = 'Response JSON tidak tersedia.';
    }
  }
  console.log(`[${entry.status}] ${entry.method} ${url}${entry.possibleNotification ? ' <-- kandidat notifikasi' : ''}`);
}

context.on('response', response => {
  const task = recordResponse(response).catch(error => {
    console.error(`Gagal membaca metadata response: ${error.message}`);
  });
  pending.add(task);
  task.finally(() => pending.delete(task));
});

let terminal;
try {
  const page = await context.newPage();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (probe) {
    await page.waitForTimeout(5000);
  } else {
    console.log('\nLogin di browser yang terbuka; selesaikan CAPTCHA jika diminta.');
    console.log('Setelah login, klik lonceng/menu notifikasi dan buka daftar review.');
    console.log('Buka juga tab Semua/Belum dibaca bila tersedia agar request-nya terekam.');
    terminal = createInterface({ input: stdin, output: stdout });
    await terminal.question('\nSetelah selesai membuka menu tersebut, tekan ENTER di terminal ini... ');
  }
  await Promise.allSettled([...pending]);
  const loginRequired = await page.locator('input[name="password"]').count() > 0;
  const report = {
    capturedAt: new Date().toISOString(),
    finalUrl: safeUrl(page.url()),
    title: await page.title(),
    loginRequired,
    documents,
    requests: [...records.values()],
    note: 'Kandidat berdasarkan URL/struktur JSON; perlu diperiksa apakah benar data notifikasi. Tidak ada header, cookie, password, atau nilai response yang direkam di laporan.',
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (!probe && !loginRequired) {
    await context.storageState({ path: fileURLToPath(statePath) });
    console.log('Sesi browser disimpan di private/session.json.');
  }
  console.log(`\nLaporan: private/${probe ? 'probe.json' : 'endpoints.json'}`);
  console.log(`Halaman akhir: ${report.title}`);
  console.log(`Fetch/XHR ditemukan: ${records.size}`);
  if (loginRequired) console.log('Masih di halaman login. Endpoint notifikasi belum dapat diverifikasi.');
} finally {
  terminal?.close();
  await browser.close();
}
