import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBankMovements } from '../js/gmail.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const purchase = (amount, date) => `compra por $${amount} con cargo a Cuenta ****1234 en COMERCIO EJEMPLO el ${date} 10:00.`;

function fakeGmail(pages, messages, calls) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const u = new URL(url);
    if (u.pathname.endsWith('/messages')) {
      const page = pages[u.searchParams.get('pageToken') || 'first'];
      return { ok: true, status: 200, json: async () => page };
    }
    const id = decodeURIComponent(u.pathname.split('/').pop());
    const m = messages[id];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id,
        internalDate: String(Date.parse('2026-11-18T12:00:00Z')),
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'From', value: `Banco <${m.from}>` }, { name: 'Subject', value: m.subject }],
          body: { data: b64(m.text) },
        },
      }),
    };
  };
}

test('fetches all pages, parses bank emails and drops movements before the start date', async () => {
  const calls = [];
  const fetchImpl = fakeGmail(
    { first: { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' }, p2: { messages: [{ id: 'c' }, { id: 'd' }] } },
    {
      a: { from: 'enviodigital@bancochile.cl', subject: 'Cargo en Cuenta', text: purchase('1.000', '18/11/2026') },
      b: { from: 'enviodigital@bancochile.cl', subject: 'Cargo en Cuenta', text: purchase('2.000', '29/10/2026') },
      c: { from: 'enviodigital@bancochile.cl', subject: 'Cartola', text: 'adjunto' },
      d: { from: 'enviodigital@bancochile.cl', subject: 'Cargo en Cuenta', text: purchase('3.000', '01/11/2026') },
    },
    calls,
  );
  const out = await fetchBankMovements('tok', '2026-10-30', { fetchImpl });
  assert.deepEqual(out.map((m) => [m.ref, m.amount, m.date]), [['gmail:a', 1000, '2026-11-18'], ['gmail:d', 3000, '2026-11-01']]);
  assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
  assert.ok(calls[0].url.includes('q=%7Bfrom%3Abancochile.cl+from%3Abancoestado.cl%7D+after%3A2026%2F10%2F29'));
  assert.ok(calls.some((c) => c.url.includes('pageToken=p2')));
});

test('reports an expired permission and other API errors in Spanish', async () => {
  const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) });
  await assert.rejects(fetchBankMovements('tok', '2026-11-01', { fetchImpl: status(401) }), /permiso de Google expiró/);
  await assert.rejects(fetchBankMovements('tok', '2026-11-01', { fetchImpl: status(500) }), /Gmail respondió 500/);
});
