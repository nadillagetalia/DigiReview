import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import makeFetchCookie from 'fetch-cookie';
import { neon } from '@neondatabase/serverless';
import { endpoint, parseNotifications } from './parse-notifications.mjs';

export function secureEqual(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createStore(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL Neon belum diisi.');
  const sql = neon(env.DATABASE_URL);
  async function query(text, params) {
    try { return await sql.query(text, params, { fetchOptions: { signal: AbortSignal.timeout(15000) } }); }
    catch { throw new Error('Database Neon gagal diakses. Periksa DATABASE_URL dan tabel digireview_kv.'); }
  }
  return {
    async get(key) {
      const rows = await query('SELECT value FROM digireview_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())', [key]);
      return rows[0]?.value ?? null;
    },
    async set(key, value) {
      await query('INSERT INTO digireview_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL', [key, value]);
    },
    async claim(key, value, seconds) {
      const rows = await query(`INSERT INTO digireview_kv (key, value, expires_at)
        VALUES ($1, $2, now() + $3 * interval '1 second')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
        WHERE digireview_kv.expires_at <= now() RETURNING key`, [key, value, seconds]);
      return rows.length > 0;
    },
    async remove(key) { await query('DELETE FROM digireview_kv WHERE key = $1', [key]); },
    async release(key, owner) {
      await query('DELETE FROM digireview_kv WHERE key = $1 AND value = $2', [key, owner]);
    },
    async cleanup() {
      await query('DELETE FROM digireview_kv WHERE expires_at < now()', []);
    },
  };
}

export function createTelegram(env = process.env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi.');
  }
  return async text => {
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text,
          link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('Koneksi Telegram gagal.'); }
    const body = await response.json();
    if (!body.ok) throw new Error(`Pengiriman Telegram gagal (HTTP ${response.status}).`);
  };
}

export async function sessionFromPlaywright(state) {
  if (!Array.isArray(state?.cookies)) throw new Error('Format sesi tidak valid.');
  const jar = new CookieJar();
  let added = 0;
  for (const cookie of state.cookies) {
    if (cookie.domain.replace(/^\./, '') !== 'digireview.id') continue;
    if (cookie.expires > 0 && cookie.expires * 1000 < Date.now()) continue;
    let value = `${cookie.name}=${cookie.value}; Path=${cookie.path || '/'}`;
    if (cookie.domain.startsWith('.')) value += `; Domain=${cookie.domain}`;
    if (cookie.secure) value += '; Secure';
    if (cookie.httpOnly) value += '; HttpOnly';
    if (cookie.expires > 0) value += `; Expires=${new Date(cookie.expires * 1000).toUTCString()}`;
    await jar.setCookie(value, endpoint);
    added++;
  }
  if (!added) throw new Error('Tidak ada cookie Digireview aktif dalam sesi.');
  return jar.toJSON();
}

export async function fetchCloudNotifications(jarJSON, persistSession) {
  const jar = CookieJar.fromJSON(jarJSON);
  const authenticatedFetch = makeFetchCookie(fetch, jar);
  let url = endpoint, first, pages = 0;
  const items = [], visited = new Set();
  while (url && pages < 10) {
    if (visited.has(url)) throw new Error('Pagination notifikasi berulang.');
    visited.add(url);
    let response;
    try {
      response = await authenticatedFetch(url, { signal: AbortSignal.timeout(15000) });
    } catch { throw new Error('Koneksi Digireview gagal.'); }
    if (!response.ok) throw new Error(`Digireview HTTP ${response.status}.`);
    const page = parseNotifications(await response.text(), response.url);
    // Persist rotated cookies before sending Telegram messages.
    await persistSession(jar.toJSON());
    first ||= page;
    items.push(...page.items);
    url = page.nextPage;
    pages++;
  }
  return { ...first, items, pages, truncated: Boolean(url) };
}

export function createMonitor({ store, send, fetchNotifications = fetchCloudNotifications }) {
  const key = 'digireview:v1:';
  const read = async name => {
    const value = await store.get(key + name);
    return value ? JSON.parse(value) : null;
  };
  const write = (name, value) => store.set(key + name, JSON.stringify(value));
  const unlock = owner => store.release(key + 'lock', owner);
  const lock = async () => {
    const owner = randomUUID();
    return await store.claim(key + 'lock', owner, 330) ? owner : null;
  };
  return {
    async uploadSession(state) {
      const session = await sessionFromPlaywright(state);
      const owner = await lock();
      if (!owner) throw new Error('Pengecekan sedang berjalan. Coba upload sesi lagi sebentar.');
      try { await write('session', session); }
      finally { await unlock(owner); }
    },
    status: () => read('state'),
    async poll() {
      const startedAt = Date.now();
      const owner = await lock();
      if (!owner) return { skipped: true, reason: 'already_running' };
      let state;
      try {
        state = await read('state') || { initialized: false, lastError: null };
        const session = await read('session');
        if (!session) throw new Error('Sesi Digireview belum diupload. Jalankan npm run cloud:session.');
        const result = await fetchNotifications(session, value => write('session', value));
        let sent = 0;
        const initial = !state.initialized;
        for (const item of [...result.items].reverse()) {
          if (Date.now() - startedAt > 210000) {
            if (initial) throw new Error('Baseline belum selesai dalam batas waktu. Coba pengecekan ulang.');
            break;
          }
          const hash = createHash('sha256').update(item.links.length
            ? item.links.map(link => link.url).sort().join('\n') : item.text).digest('hex');
          if (!await store.get(key + 'seen:' + hash)) {
            if (!initial) {
              // Limit sends per invocation so serverless execution remains bounded.
              if (sent >= 20) break;
              await send(`Notifikasi Digireview baru\n\n${item.text.slice(0, 2800)}\n\n${item.links.map(link => link.url).join('\n').slice(0, 1000)}`);
              sent++;
            }
            await store.set(key + 'seen:' + hash, '1');
          }
        }
        state = { initialized: true, lastChecked: result.fetchedAt,
          unreadCount: result.unreadCount, lastError: null, truncated: result.truncated };
        await write('state', state);
        if (initial) await send(`Pemantauan Digireview di Vercel aktif. Belum dibaca: ${result.unreadCount ?? 'tidak diketahui'}. Notifikasi lama dijadikan data awal.`);
        return { ok: true, sent, unreadCount: result.unreadCount, truncated: result.truncated };
      } catch (error) {
        state ||= {};
        if (state.lastError !== error.message) {
          await send(`Pemantauan Digireview terkendala: ${error.message}`);
          state.lastError = error.message;
          await write('state', state);
        }
        throw error;
      } finally { await unlock(owner); }
    },
  };
}
