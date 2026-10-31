import { request } from 'playwright';
import { parseNotifications } from './lib/parse-notifications.mjs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const endpoint = 'https://digireview.id/notifikasi';
const dir = new URL('./private/', import.meta.url);
const statePath = fileURLToPath(new URL('session.json', dir));
export async function fetchNotifications(client) {
  const response = await client.get(endpoint, { timeout: 60000 });
  if (!response.ok()) throw new Error(`HTTP ${response.status()} dari endpoint notifikasi.`);
  const result = parseNotifications(await response.text(), response.url());
  await writeFile(new URL('notifications.json', dir), JSON.stringify(result, null, 2), { mode: 0o600 });
  await client.storageState({ path: statePath });
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const client = await request.newContext({ storageState: statePath });
  try {
    const result = await fetchNotifications(client);
    console.log(`HTTP 200 - ${endpoint}`);
    console.log(`Belum dibaca: ${result.unreadCount ?? 'tidak diketahui'}; baris halaman pertama: ${result.items.length}`);
    console.log('Hasil: private/notifications.json');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await client.dispose();
  }
}
