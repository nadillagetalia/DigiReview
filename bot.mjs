import { loadEnvFile } from 'node:process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'playwright';
import { fetchNotifications } from './notifications.mjs';

try { loadEnvFile(fileURLToPath(new URL('.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Isi TELEGRAM_BOT_TOKEN di .env terlebih dahulu.');
const seconds = Number(process.env.POLL_SECONDS || 60);
if (!Number.isFinite(seconds) || seconds < 30) throw new Error('POLL_SECONDS minimal 30.');

async function telegram(method, body = {}) {
  // Do not log fetch errors: their URL may contain the bot token.
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(40000),
    });
  } catch {
    throw new Error(`Koneksi Telegram gagal (${method}).`);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Respons Telegram tidak valid (${method}, HTTP ${response.status}).`); }
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}

const dir = new URL('./private/', import.meta.url);
const stateFile = new URL('bot-state.json', dir);
let state = { offset: 0, chatId: null, initialized: false, seen: [], lastError: null };
try { state = { ...state, ...JSON.parse(await readFile(stateFile, 'utf8')) }; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (process.env.TELEGRAM_CHAT_ID) {
  const chatId = Number(process.env.TELEGRAM_CHAT_ID);
  if (!Number.isSafeInteger(chatId)) throw new Error('TELEGRAM_CHAT_ID harus berupa angka.');
  state.chatId = chatId;
}
async function save() {
  const temp = new URL('bot-state.tmp', dir);
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, stateFile);
}
const send = text => telegram('sendMessage', {
  chat_id: state.chatId, text, link_preview_options: { is_disabled: true },
});
// Prefer a stable link over human-readable dates/status text when available.
const itemId = item => createHash('sha256')
  .update(item.links.length ? item.links.map(link => link.url).sort().join('\n') : item.text)
  .digest('hex');

const me = await telegram('getMe');
console.log(`Bot terhubung: @${me.username} (ID ${me.id})`);
if (process.argv.includes('--check')) {
  const updates = await telegram('getUpdates', { offset: state.offset, timeout: 0, allowed_updates: ['message'] });
  const starts = updates.filter(update => update.message?.chat.type === 'private' &&
    /^\/start(?:@\w+)?(?:\s|$)/.test(update.message.text || ''));
  console.log(`Pesan /start privat tersedia: ${starts.length}`);
  console.log(state.chatId ? 'Penerima sudah tersimpan.' : `Buka https://t.me/${me.username} lalu tekan Start.`);
} else {

const client = await request.newContext({
  storageState: fileURLToPath(new URL('session.json', dir)),
});
let running = true;
process.once('SIGINT', () => { running = false; });
process.once('SIGTERM', () => { running = false; });
let nextPoll = 0;
console.log(`Pemantauan aktif setiap ${seconds} detik. Hentikan dengan Ctrl+C.`);
if (!state.chatId) console.log(`Buka https://t.me/${me.username} lalu tekan Start untuk menghubungkan penerima pertama.`);
try {
  while (running) {
    try {
      const updates = await telegram('getUpdates', {
        offset: state.offset, timeout: 10, allowed_updates: ['message'],
      });
      for (const update of updates) {
        const message = update.message;
        if (message?.chat.type === 'private') {
          const command = (message.text || '').split(/\s/)[0].split('@')[0];
          if (!state.chatId && command === '/start') {
            state.chatId = message.chat.id;
            await save();
            console.log('Chat penerima berhasil dihubungkan.');
          }
          if (message.chat.id === state.chatId) {
            if (command === '/start') {
              await send('Terhubung ke pemantau Digireview. Notifikasi baru akan dikirim otomatis. Gunakan /status untuk status dan /cek untuk cek sekarang.');
              nextPoll = 0;
            } else if (command === '/status') {
              await send(`Pemantauan setiap ${seconds} detik.\nCek terakhir: ${state.lastChecked || 'belum ada'}\nBelum dibaca: ${state.unreadCount ?? 'belum diketahui'}\n${state.lastError || 'Koneksi terakhir tidak mengalami error.'}`);
            } else if (command === '/cek') nextPoll = 0;
          }
        }
        state.offset = update.update_id + 1;
        await save();
      }
      if (state.chatId && Date.now() >= nextPoll) {
        nextPoll = Date.now() + seconds * 1000;
        // Reload cookies so login ulang via discover is picked up without a restart.
        const freshState = JSON.parse(await readFile(new URL('session.json', dir), 'utf8'));
        await client.clearCookies();
        await client.addCookies(freshState.cookies);
        try {
          const result = await fetchNotifications(client);
          if (!state.initialized) {
            state.seen = result.items.map(itemId);
            state.initialized = true;
            await save();
            await send(`Pemantauan Digireview aktif. Belum dibaca: ${result.unreadCount ?? 'tidak diketahui'}. Notifikasi yang sudah ada dijadikan data awal; notifikasi baru berikutnya akan dikirim.`);
          } else {
            for (const item of [...result.items].reverse()) {
              const id = itemId(item);
              if (state.seen.includes(id)) continue;
              const links = item.links.map(link => link.url).join('\n');
              const text = `Notifikasi Digireview baru\n\n${item.text}`;
              await send(`${text.slice(0, 2800)}\n\n${links.slice(0, 1000)}`);
              state.seen.push(id);
              await save();
            }
          }
          state.lastChecked = result.fetchedAt;
          state.unreadCount = result.unreadCount;
          state.lastError = null;
          await save();
          console.log(`${result.fetchedAt}: belum dibaca ${result.unreadCount}, baris ${result.items.length}.`);
        } catch (error) {
          if (state.lastError !== error.message) {
            await send(`Pemantauan Digireview terkendala: ${error.message}`);
            state.lastError = error.message;
            await save();
          }
          console.error(error.message);
        }
      }
    } catch (error) {
      console.error(error.message);
      await sleep(10000);
    }
  }
} finally {
  await client.dispose();
}
}
