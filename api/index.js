import { createStore, createTelegram, createMonitor, secureEqual } from '../lib/cloud.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const route = new URL(req.url, 'https://localhost').pathname;
  const env = process.env;
  try {
    if (route === '/api/cron' || route === '/api/session') {
      if (!secureEqual(req.headers.authorization, env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const method = route === '/api/cron' ? 'GET' : 'PUT';
      if (req.method !== method) return res.status(405).json({ error: 'Method not allowed' });
      const store = createStore();
      const monitor = createMonitor({ store, send: createTelegram() });
      if (route === '/api/session') {
        await monitor.uploadSession(req.body);
        return res.status(200).json({ ok: true });
      }
      await store.cleanup();
      return res.status(200).json(await monitor.poll());
    }
    if (route !== '/api/telegram') return res.status(404).json({ error: 'Not found' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!secureEqual(req.headers['x-telegram-bot-api-secret-token'], env.TELEGRAM_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const update = req.body;
    const message = update?.message;
    if (!message || message.chat.type !== 'private' ||
      String(message.chat.id) !== env.TELEGRAM_CHAT_ID) return res.status(200).json({ ok: true });
    const command = (message.text || '').split(/\s/)[0].split('@')[0];
    if (!['/start', '/status', '/cek'].includes(command)) return res.status(200).json({ ok: true });
    const store = createStore(), send = createTelegram();
    const monitor = createMonitor({ store, send });
    // Deduplicate webhook retries; remove the marker on failure so Telegram can retry.
    const marker = `digireview:v1:update:${update.update_id}`;
    if (!await store.claim(marker, '1', 86400)) return res.status(200).json({ ok: true });
    try {
      if (command === '/start') {
        await send('Bot Digireview terhubung ke Vercel. Gunakan /cek untuk cek sekarang dan /status untuk status. Pengecekan otomatis mengikuti jadwal scheduler.');
      } else if (command === '/cek') {
        const result = await monitor.poll();
        await send(result.skipped ? 'Pengecekan lain sedang berjalan.' :
          `Cek selesai. Belum dibaca: ${result.unreadCount ?? 'tidak diketahui'}. Notifikasi baru terkirim: ${result.sent}.`);
      } else {
        const state = await monitor.status();
        await send(`Cek terakhir: ${state?.lastChecked || 'belum ada'}\nBelum dibaca: ${state?.unreadCount ?? 'belum diketahui'}\n${state?.lastError || 'Tidak ada error tersimpan.'}`);
      }
    } catch (error) {
      await store.remove(marker);
      throw error;
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    // Don't expose cookies, tokens, URLs with credentials, or upstream bodies.
    console.error('Bot request gagal:', error.message);
    return res.status(503).json({ error: 'Operasi gagal. Periksa konfigurasi, log fungsi, dan pesan bot.' });
  }
}
