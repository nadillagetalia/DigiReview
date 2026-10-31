import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor, secureEqual, sessionFromPlaywright } from '../lib/cloud.mjs';
import { parseNotifications } from '../lib/parse-notifications.mjs';
import handler from '../api/index.js';

function memoryStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async claim(key, value) {
      if (values.has(key)) return false;
      values.set(key, value); return true;
    },
    async release(key, owner) { if (values.get(key) === owner) values.delete(key); },
    async remove(key) { values.delete(key); },
  };
}
const item = id => ({ text: `Dokumen ${id}`, links: [{ url: `https://digireview.id/notifikasi/${id}`, text: 'Buka' }] });
const page = items => ({ items, fetchedAt: '2026-10-31T00:00:00Z', unreadCount: items.length, truncated: false });

test('HTML login/unknown is never mistaken for zero notifications', () => {
  assert.throws(() => parseNotifications('<input name="password">'), /Sesi login habis/);
  assert.throws(() => parseNotifications('<h1>Error</h1>'), /tidak dikenal/);
});

test('parser scopes notification rows and excludes navigation/mark-all links', () => {
  const html = `<span id="notificationCount">1</span><a href="/logout">Logout</a>
  <div class="main-panel"><div class="content-wrapper"><a href="/notifikasi/mark-all-as-read">Read all</a>
  <table><tbody><tr><td>Review baru <a href="/approver/project/1">Dokumen</a></td></tr></tbody></table>
  </div></div><ul class="pagination"><li class="page-item"><a class="page-link" href="/notifikasi?page=2">Next</a></li></ul>`;
  const result = parseNotifications(html);
  assert.equal(result.unreadCount, 1);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].links.map(link => link.url), ['https://digireview.id/approver/project/1']);
  assert.equal(result.nextPage, 'https://digireview.id/notifikasi?page=2');
});

test('cookies for unrelated domains are not imported', async () => {
  const session = await sessionFromPlaywright({ cookies: [
    { name: 'session', value: 'example', domain: 'digireview.id', path: '/', expires: -1, secure: true },
    { name: 'other', value: 'ignore', domain: 'other.example', path: '/', expires: -1 },
  ] });
  assert.equal(session.cookies.length, 1);
  assert.equal(session.cookies[0].key, 'session');
});

test('baseline is silent for old items; new notifications persist across instances', async () => {
  const store = memoryStore(), messages = [];
  await store.set('digireview:v1:session', '{}');
  let current = [item(1)];
  const options = { store, send: async text => messages.push(text), fetchNotifications: async () => page(current) };
  await createMonitor(options).poll();
  assert.equal(messages.length, 1); // startup confirmation only
  current = [item(2), item(1)];
  const second = await createMonitor(options).poll();
  assert.equal(second.sent, 1);
  assert.match(messages[1], /Dokumen 2/);
  assert.equal((await createMonitor(options).poll()).sent, 0);
});

test('failed Telegram send remains retryable, rather than being marked seen', async () => {
  const store = memoryStore();
  await store.set('digireview:v1:session', '{}');
  await store.set('digireview:v1:state', JSON.stringify({ initialized: true }));
  let fail = true;
  const monitor = createMonitor({ store, fetchNotifications: async () => page([item(3)]),
    send: async text => { if (fail && text.startsWith('Notifikasi')) throw new Error('Telegram sementara gagal'); } });
  await assert.rejects(monitor.poll(), /sementara gagal/);
  fail = false;
  assert.equal((await monitor.poll()).sent, 1);
});

test('concurrent monitor invocation skips instead of sending twice', async () => {
  const store = memoryStore();
  await store.set('digireview:v1:session', '{}');
  let resume, began;
  const ready = new Promise(resolve => { began = resolve; });
  const wait = new Promise(resolve => { resume = resolve; });
  const options = { store, send: async () => {}, fetchNotifications: async () => { began(); await wait; return page([]); } };
  const first = createMonitor(options).poll();
  await ready;
  assert.equal((await createMonitor(options).poll()).skipped, true);
  resume();
  await first;
});

test('handler rejects unauthenticated calls before touching database', async () => {
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
  await handler({ url: '/api/cron', method: 'GET', headers: {} }, res);
  assert.equal(res.code, 401);
  await handler({ url: '/api/telegram', method: 'POST', headers: {} }, res);
  assert.equal(res.code, 401);
  assert.equal(secureEqual('a', 'aa'), false);
  assert.equal(secureEqual('', ''), false);
});
