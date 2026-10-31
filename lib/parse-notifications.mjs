import { load } from 'cheerio';

export const endpoint = 'https://digireview.id/notifikasi';

export function parseNotifications(html, finalUrl = endpoint) {
  const $ = load(html);
  if (new URL(finalUrl).pathname === '/login' || $('input[name="password"]').length) {
    throw new Error('Sesi login habis. Login ulang di PC lalu upload sesi terbaru.');
  }
  const table = $('.main-panel .content-wrapper table tbody');
  if (!table.length) throw new Error('Struktur halaman notifikasi tidak dikenal.');
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const items = [];
  if (!/tidak ada notifikasi/i.test(normalize(table.text()))) {
    table.find('tr').each((_, row) => {
      const text = normalize($(row).text());
      if (!text) return;
      const links = $(row).find('a[href]').map((_, link) => {
        const href = $(link).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
        const url = new URL(href, endpoint);
        if (url.origin !== new URL(endpoint).origin) return null;
        return { text: normalize($(link).text()), url: url.href };
      }).get();
      items.push({ text, links });
    });
    if (!items.length) throw new Error('Baris notifikasi tidak dikenali.');
  }
  const count = normalize($('#notificationCount').text());
  const nextHref = $('.pagination .page-item:not(.disabled) .page-link')
    .filter((_, link) => /next/i.test($(link).text())).first().attr('href');
  const nextPage = nextHref ? new URL(nextHref, endpoint).href : null;
  if (nextPage && (new URL(nextPage).origin !== new URL(endpoint).origin ||
    new URL(nextPage).pathname !== '/notifikasi')) throw new Error('Pagination tidak dikenal.');
  return {
    fetchedAt: new Date().toISOString(), endpoint,
    unreadCount: /^\d+$/.test(count) ? Number(count) : null,
    items, nextPage,
    note: 'Parsing baris berisi notifikasi belum diverifikasi dengan data nyata.',
  };
}
