import { loadEnvFile } from 'node:process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { sessionFromPlaywright, fetchCloudNotifications, createStore } from '../lib/cloud.mjs';

const root = new URL('../', import.meta.url);
const configFile = new URL('private/vercel.env', root);
const mode = process.argv[2];
try {
  if (mode === '--prepare') {
    loadEnvFile(fileURLToPath(new URL('.env', root)));
    const local = JSON.parse(await readFile(new URL('private/bot-state.json', root), 'utf8'));
    if (!local.chatId || !process.env.TELEGRAM_BOT_TOKEN) throw new Error('Token atau chat ID lokal belum tersedia.');
    const secret = () => randomBytes(32).toString('hex');
    const text = [
      `TELEGRAM_BOT_TOKEN=${process.env.TELEGRAM_BOT_TOKEN}`,
      `TELEGRAM_CHAT_ID=${local.chatId}`,
      `TELEGRAM_WEBHOOK_SECRET=${secret()}`,
      `CRON_SECRET=${secret()}`,
      'DATABASE_URL=',
      'DEPLOYMENT_URL=',
      '',
    ].join('\n');
    await writeFile(configFile, text, { flag: 'wx', mode: 0o600 });
    console.log('Konfigurasi dibuat di private/vercel.env (token tidak ditampilkan).');
    console.log('Isi DATABASE_URL Neon dan DEPLOYMENT_URL, lalu salin variabel ke Vercel.');
  } else if (mode === '--probe') {
    const state = JSON.parse(await readFile(new URL('private/session.json', root), 'utf8'));
    const result = await fetchCloudNotifications(await sessionFromPlaywright(state), async () => {});
    console.log(`Request HTTP tanpa browser berhasil: belum dibaca ${result.unreadCount}, ${result.items.length} baris, ${result.pages} halaman.`);
  } else {
    loadEnvFile(fileURLToPath(configFile));
    if (mode === '--db-check') {
      const store = createStore();
      const key = `digireview:connection-test:${randomBytes(12).toString('hex')}`;
      try {
        if (!await store.claim(key, 'probe', 60)) throw new Error('Lock pertama gagal.');
        if (await store.claim(key, 'other', 60)) throw new Error('Lock ganda diterima.');
        await store.release(key, 'other');
        if (await store.get(key) !== 'probe') throw new Error('Pemilik lock tidak cocok.');
        await store.release(key, 'probe');
        await store.set(key, 'read-write-ok');
        if (await store.get(key) !== 'read-write-ok') throw new Error('Baca/tulis tidak cocok.');
        console.log('Neon terverifikasi: koneksi, baca/tulis, dan lock atomik berhasil.');
      } finally { await store.remove(key); }
    } else if (mode === '--db') {
      if (!process.env.DATABASE_URL) throw new Error('Isi DATABASE_URL di private/vercel.env.');
      const sql = neon(process.env.DATABASE_URL);
      const statements = (await readFile(new URL('schema.sql', root), 'utf8')).split(';').map(s => s.trim()).filter(Boolean);
      for (const statement of statements) await sql.query(statement);
      console.log('Tabel Neon siap.');
    } else {
      const base = new URL(process.env.DEPLOYMENT_URL);
      if (base.protocol !== 'https:') throw new Error('DEPLOYMENT_URL harus HTTPS.');
      if (mode === '--session') {
        const session = await readFile(new URL('private/session.json', root), 'utf8');
        const response = await fetch(new URL('/api/session', base), {
          method: 'PUT', headers: { Authorization: `Bearer ${process.env.CRON_SECRET}`, 'Content-Type': 'application/json' },
          body: session, signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`Upload sesi gagal (HTTP ${response.status}). Periksa deployment dan konfigurasi.`);
        console.log('Sesi login berhasil disimpan di Neon.');
      } else if (mode === '--webhook') {
        const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: new URL('/api/telegram', base).href,
            secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message'] }),
          signal: AbortSignal.timeout(30000),
        });
        const result = await response.json();
        if (!result.ok) throw new Error('Pendaftaran webhook gagal. Periksa token dan URL deployment.');
        console.log(`Webhook Telegram terpasang ke ${new URL('/api/telegram', base).href}`);
      } else if (mode === '--check') {
        const response = await fetch(new URL('/api/cron', base), {
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
          signal: AbortSignal.timeout(290000),
        });
        console.log(`HTTP ${response.status}: ${await response.text()}`);
        if (!response.ok) process.exitCode = 1;
      } else throw new Error('Mode tidak dikenal. Gunakan script cloud:* di package.json.');
    }
  }
} catch {
  // External errors can embed database URLs or bot tokens. Keep output generic.
  console.error('Setup gagal. Periksa mode, private/vercel.env, sesi login, koneksi, dan variabel di Vercel.');
  if (mode === '--prepare') console.error('File yang sudah ada tidak ditimpa; periksa private/vercel.env.');
  process.exitCode = 1;
}
