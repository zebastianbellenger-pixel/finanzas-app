import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToText, parseBankEmail, suggestCategory, planImport, decodeBase64Url, messageBody, gmailQuery,
} from '../js/bankmail.js';
import { createEmptyState } from '../js/store.js';

// Synthetic emails in the layout Banco de Chile uses (names, accounts and amounts are fictitious).
const PURCHASE_HTML = `<html><body><table><tr><td>Persona Ejemplo:</td></tr><tr><td>Te informamos que se ha
realizado una compra por $12.340 con cargo a Cuenta ****1234 en MERPAGO*MINISUPER el 18/11/2026 09:23.<br />
Revisa Saldos y Movimientos en App Mi Banco o Banco en L&iacute;nea.</td></tr></table></body></html>`;

const TRANSFER_HTML = `<table>
<tr><td>Comprobante de Transferencia a terceros</td></tr>
<tr><td>Destino</td></tr>
<tr><td>Nombre y Apellido</td><td>Tarjeta Cmr</td></tr>
<tr><td>Rut</td><td>11.111.111-1</td></tr>
<tr><td>Banco</td><td>Banco Ejemplo</td></tr>
<tr><td>Monto</td><td>$85.000</td></tr>
<tr><td>Fecha y Hora: viernes 13 de noviembre de 2026 21:01 Transacción TEF123</td></tr>
</table>`;

const BILL_TEXT = `Comprobante de pago electrónico
| Comercio | SERVIPAG |
| Descripción | Precio | Cantidad | Monto |
| Luz Ejemplo | $25.000 | 1 | $25.000 |
| Agua Ejemplo | $20.000 | 1 | $20.000 |
| Monto total | $45.000 |
| Fecha y Hora |
| viernes 30 de octubre 2026 16:56 Hrs. |`;

const LOAN_TEXT = `Te informamos que has realizado un Pago de Cuota de tu Crédito de Consumo N° 0001, el día 31/08/2026.
| N° Cuota | 6 |
| Monto Pagado | $ 37.000 |`;

const email = (over) => ({ id: 'm1', from: 'enviodigital@bancochile.cl', subject: '', date: '2026-11-18T12:23:50Z', text: '', ...over });

test('htmlToText keeps table cells apart and decodes entities', () => {
  const t = htmlToText('<tr><td>Monto</td><td>$5.000</td></tr><p>L&iacute;nea&nbsp;uno</p>');
  assert.match(t, /Monto \| \$5\.000/);
  assert.match(t, /Línea uno/);
  assert.doesNotMatch(t, /<|&/);
});

test('htmlToText drops out-of-range numeric entities instead of throwing', () => {
  assert.equal(htmlToText('a&#99999999;b&#x110000;c&#65;'), 'abcA');
});

test('parses a purchase charged to the account', () => {
  const m = parseBankEmail(email({ subject: 'Cargo en Cuenta', text: htmlToText(PURCHASE_HTML) }));
  assert.deepEqual(m, {
    ref: 'gmail:m1', bank: 'Banco de Chile', kind: 'purchase', amount: 12340, date: '2026-11-18',
    description: 'MERPAGO*MINISUPER', account: '1234',
  });
});

test('parses an outgoing transfer to a third party', () => {
  const m = parseBankEmail(email({
    from: 'serviciodetransferencias@bancochile.cl', subject: 'Transferencia a Terceros', text: htmlToText(TRANSFER_HTML),
  }));
  assert.equal(m.kind, 'transfer');
  assert.equal(m.amount, 85000);
  assert.equal(m.date, '2026-11-13');
  assert.equal(m.description, 'Transferencia a Tarjeta Cmr');
  assert.equal(m.beneficiary, 'Tarjeta Cmr');
});

test('parses a bill payment and a loan installment', () => {
  const bill = parseBankEmail(email({ subject: 'Pago de Comercios', text: BILL_TEXT }));
  assert.equal(bill.kind, 'bill');
  assert.equal(bill.amount, 45000);
  assert.equal(bill.date, '2026-10-30');
  assert.equal(bill.description, 'Pago SERVIPAG: Luz Ejemplo, Agua Ejemplo');
  const loan = parseBankEmail(email({ subject: 'Comprobante Pago Credito Consumo', text: LOAN_TEXT }));
  assert.equal(loan.kind, 'loan');
  assert.equal(loan.amount, 37000);
  assert.equal(loan.date, '2026-08-31');
  assert.equal(loan.description, 'Cuota 6 crédito de consumo');
});

test('ignores incoming money, own-account transfers, statements and unknown senders', () => {
  const cases = [
    { subject: 'Transferencia entre Mis Cuentas', text: 'Monto | $10.000' },
    { subject: 'Transferencias de Fondos de Alguien', text: 'Alguien le ha transferido $30.000' },
    { subject: 'Cartola Cuenta Corriente', text: 'Adjunto' },
    { subject: 'Aviso de Transferencia de Fondos BancoEstado', from: 'notificaciones@correo.bancoestado.cl', text: 'Hemos realizado una Transferencia instruida por nuestro cliente EMPRESA' },
    { subject: 'Cargo en Cuenta', from: 'otro@ejemplo.com', text: htmlToText(PURCHASE_HTML) },
    { subject: 'Cargo en Cuenta', text: 'sin monto reconocible' },
  ];
  for (const c of cases) assert.equal(parseBankEmail(email(c)), null, c.subject);
});

test('suggests categories from the merchant', () => {
  assert.equal(suggestCategory('MERPAGO*MINISUPER'), 'supermercado');
  assert.equal(suggestCategory('COPEC RUTA 68'), 'combustible');
  assert.equal(suggestCategory('CINEMARK CHILE AP'), 'ocio');
  assert.equal(suggestCategory('EMPANADAS LA ESQUINA'), 'comida');
  assert.equal(suggestCategory('RAPPI CHILE'), 'delivery');
  assert.equal(suggestCategory('FARMACIAS CRUZ VERDE'), 'salud');
  assert.equal(suggestCategory('ALGO DESCONOCIDO'), 'otros');
});

test('plans the import without double counting', () => {
  const s = createEmptyState();
  s.debts.push({ id: 'c1', name: 'CMR Falabella', type: 'card', payment: 80000, balance: null });
  s.expenses.push(
    { id: 'old', date: '2026-11-01', amount: 999, category: 'otros', ref: 'gmail:seen' },
    { id: 'gone', date: '2026-11-02', amount: 1, category: 'otros', ref: 'gmail:deleted', deleted: true },
    { id: 'manual', date: '2026-11-17', amount: 12340, category: 'supermercado' },
  );
  s.debtPayments.push({ id: 'dp', debtId: 'c1', date: '2026-11-03', amount: 80000, ref: 'gmail:paid' });
  const mov = (ref, over) => ({ ref, bank: 'Banco de Chile', amount: 1000, date: '2026-11-10', description: 'X', ...over });
  const rows = planImport([
    mov('gmail:seen', { kind: 'purchase' }),
    mov('gmail:deleted', { kind: 'purchase' }),
    mov('gmail:paid', { kind: 'transfer', beneficiary: 'Tarjeta Cmr' }),
    mov('gmail:dup', { kind: 'purchase', amount: 12340, date: '2026-11-18', description: 'MERPAGO*MINISUPER' }),
    mov('gmail:new', { kind: 'purchase', description: 'CINEMARK' }),
    mov('gmail:card', { kind: 'transfer', beneficiary: 'Tarjeta Cmr' }),
    mov('gmail:friend', { kind: 'transfer', beneficiary: 'Persona Ejemplo' }),
    mov('gmail:bill', { kind: 'bill' }),
    mov('gmail:loan', { kind: 'loan' }),
  ], s);
  assert.deepEqual(rows.map((r) => r.ref), ['gmail:dup', 'gmail:new', 'gmail:card', 'gmail:friend', 'gmail:bill', 'gmail:loan']);
  const by = Object.fromEntries(rows.map((r) => [r.ref, r]));
  assert.deepEqual(by['gmail:dup'].action, { type: 'skip' });
  assert.equal(by['gmail:dup'].duplicateOf, 'manual');
  assert.deepEqual(by['gmail:new'].action, { type: 'expense', category: 'ocio' });
  assert.deepEqual(by['gmail:card'].action, { type: 'debt', debtId: 'c1' });
  assert.deepEqual(by['gmail:friend'].action, { type: 'expense', category: 'otros' });
  assert.deepEqual(by['gmail:bill'].action, { type: 'skip' });
  assert.deepEqual(by['gmail:loan'].action, { type: 'skip' });
  assert.ok(by['gmail:bill'].reason && by['gmail:loan'].reason && by['gmail:dup'].reason);
});

test('decodes Gmail message bodies, preferring plain text and falling back to HTML', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeBase64Url(b64('Línea ñ $1.000')), 'Línea ñ $1.000');
  const plain = { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/html', body: { data: b64('<td>html</td>') } },
    { mimeType: 'text/plain', body: { data: b64('texto plano') } },
  ] };
  assert.equal(messageBody(plain), 'texto plano');
  const htmlOnly = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<td>Monto</td><td>$1</td>') } }] },
    { mimeType: 'application/pdf', filename: 'x.pdf', body: { attachmentId: 'a' } },
  ] };
  assert.match(messageBody(htmlOnly), /Monto \| \$1/);
  assert.equal(messageBody({ mimeType: 'text/plain', body: {} }), '');
});

test('builds the Gmail search query from a start date', () => {
  assert.equal(gmailQuery('2026-10-30'), '{from:bancochile.cl from:bancoestado.cl} after:2026/10/29');
});

test('rejects spoofed senders that only look like the bank', () => {
  const text = htmlToText(PURCHASE_HTML);
  for (const from of ['x@bancochile.cl.evil.com', 'x@bancoestado.cl.evil.com', '"aviso@bancochile.cl" <a@evil.com>', 'x@evil-bancochile.cl']) {
    assert.equal(parseBankEmail(email({ from, subject: 'Cargo en Cuenta', text })), null, from);
  }
  assert.equal(parseBankEmail(email({ from: 'Banco de Chile <enviodigital@bancochile.cl>', subject: 'Cargo en Cuenta', text })).bank, 'Banco de Chile');
  assert.equal(parseBankEmail(email({ from: 'notificaciones@correo.bancoestado.cl', subject: 'Cargo en Cuenta', text })).bank, 'BancoEstado');
});

test('company suffixes do not match a transfer to the wrong debt', () => {
  const s = createEmptyState();
  s.debts.push({ id: 'l1', name: 'Crédito Falabella SpA', type: 'loan', payment: 1, balance: null });
  const [row] = planImport([{ ref: 'gmail:x', kind: 'transfer', beneficiary: 'Rappi SpA', amount: 5000, date: '2026-11-10', description: 'T' }], s);
  assert.deepEqual(row.action, { type: 'expense', category: 'otros' });
});

test('a manual expense is matched to the email of the same day first', () => {
  const s = createEmptyState();
  s.expenses.push({ id: 'manual', date: '2026-11-17', amount: 2000, category: 'comida' });
  const mov = (ref, date) => ({ ref, kind: 'purchase', amount: 2000, date, description: 'X' });
  const rows = planImport([mov('gmail:18', '2026-11-18'), mov('gmail:17', '2026-11-17')], s);
  const by = Object.fromEntries(rows.map((r) => [r.ref, r]));
  assert.equal(by['gmail:17'].duplicateOf, 'manual');
  assert.equal(by['gmail:18'].action.type, 'expense');
});

test('emails skipped in a previous import are not offered again', () => {
  const s = createEmptyState();
  s.importedRefs.push({ id: 'gmail:skipped' });
  const rows = planImport([{ ref: 'gmail:skipped', kind: 'bill', amount: 1, date: '2026-11-01', description: 'X' }], s);
  assert.deepEqual(rows, []);
});
