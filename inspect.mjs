import { request } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = new URL('./private/', import.meta.url);
await mkdir(dir, { recursive: true });
const client = await request.newContext({
  storageState: fileURLToPath(new URL('session.json', dir)),
});
try {
  const url = process.env.DIGIREVIEW_URL ||
    'https://digireview.id/approver/project/106021/template/32120?dokumen=100012';
  const response = await client.get(url);
  const html = await response.text();
  await writeFile(new URL('page.html', dir), html, { mode: 0o600 });
  console.log(`HTTP ${response.status()}; URL: ${response.url()}`);
  console.log(`HTML tersimpan: private/page.html (${html.length} karakter)`);
} finally {
  await client.dispose();
}
