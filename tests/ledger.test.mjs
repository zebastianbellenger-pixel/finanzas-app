import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMovement, cartolaRecords, emailRecords, monthlyReport, monthsAvailable } from '../js/ledger.js';
import { createEmptyState, normalizeState } from '../js/store.js';

const debts = [{ id: 'c1', name: 'CMR Falabella', type: 'card', payment: 80000, balance: null }];

test('classifies cartola and email movements into report groups', () => {
  const c = (description, direction = 'out') => classifyMovement({ description, direction, source: 'cartola' }, debts);
  assert.equal(c('PAGO:MERPAGO*MINISUPER'), 'supermercado');
  assert.equal(c('PAGO:PAYU *UBER EATS'), 'delivery');
  assert.equal(c('TRASPASO A:Tarjeta Cmr'), 'deudas');
  assert.equal(c('TRASPASO A:Persona Ejemplo'), 'transferencias');
  assert.equal(c('PAGO EN SERVIPAG.COM*'), 'cuentas');
  assert.equal(c('RECAUDACION Y PAGOS DE SERVICIOS'), 'cuentas');
  assert.equal(c('COMISION ADMIN. MENSUAL PLAN CUENT'), 'comisiones');
  assert.equal(c('TRASPASO A CUENTA:000099990000'), 'interno');
  assert.equal(c('TRASPASO DE CUENTA:000099990000', 'in'), 'interno');
  assert.equal(c('TRASPASO DE:EMPRESA EJEMPLO', 'in'), 'ingreso');
  const e = (kind, over = {}) => classifyMovement({ kind, direction: 'out', source: 'gmail', description: 'X', ...over }, debts);
  assert.equal(e('bill'), 'cuentas');
  assert.equal(e('loan'), 'deudas');
  assert.equal(e('transfer', { beneficiary: 'Tarjeta Cmr' }), 'deudas');
  assert.equal(e('transfer', { beneficiary: 'Persona Ejemplo' }), 'transferencias');
  assert.equal(e('purchase', { description: 'CINEMARK' }), 'ocio');
});

const statement = (account, from, to, movements) => ({ account, accountType: 'Cuenta Corriente', from, to, movements, warnings: [] });

test('cartola records get stable ids so re-importing or overlapping statements never duplicates', () => {
  const parsed = statement('1234', '2026-09-30', '2026-10-30', [
    { date: '2026-10-01', description: 'PAGO:UNO', amount: 1000, direction: 'out' },
    { date: '2026-10-01', description: 'PAGO:UNO', amount: 1000, direction: 'out' },
  ]);
  const a = cartolaRecords(parsed);
  const b = cartolaRecords(parsed);
  assert.deepEqual(a.movements.map((m) => m.id), b.movements.map((m) => m.id));
  assert.equal(new Set(a.movements.map((m) => m.id)).size, 2);
  assert.equal(a.statement.id, 'stmt:1234:2026-09-30');
  assert.deepEqual({ ...a.movements[0], id: undefined }, {
    id: undefined, date: '2026-10-01', amount: 1000, direction: 'out', description: 'PAGO:UNO', account: '1234', source: 'cartola', kind: '',
  });
});

test('monthly report: cartola wins over emails for covered days and own-account transfers are excluded', () => {
  const s = createEmptyState();
  s.debts.push(...debts);
  const { statement: st, movements } = cartolaRecords(statement('1234', '2026-09-30', '2026-10-30', [
    { date: '2026-10-01', description: 'PAGO:MERPAGO*MINISUPER', amount: 5000, direction: 'out' },
    { date: '2026-10-01', description: 'TRASPASO A:Tarjeta Cmr', amount: 80000, direction: 'out' },
    { date: '2026-10-02', description: 'TRASPASO A CUENTA:000099990000', amount: 20000, direction: 'out' },
    { date: '2026-10-03', description: 'TRASPASO DE:EMPRESA EJEMPLO', amount: 900000, direction: 'in' },
  ]));
  s.statements.push(st);
  s.bankMovements.push(...movements, ...emailRecords([
    { ref: 'gmail:a', kind: 'purchase', amount: 5000, date: '2026-10-01', description: 'MERPAGO*MINISUPER', account: '1234' },
    { ref: 'gmail:b', kind: 'purchase', amount: 7000, date: '2026-10-31', description: 'CINEMARK', account: '1234' },
    { ref: 'gmail:c', kind: 'purchase', amount: 3000, date: '2026-10-15', description: 'COPEC', account: '9999' },
  ]));
  const r = monthlyReport(s, '2026-10');
  assert.equal(r.out, 5000 + 80000 + 7000 + 3000);
  assert.equal(r.in, 900000);
  assert.deepEqual(r.groups.map((g) => [g.id, g.value]), [['deudas', 80000], ['ocio', 7000], ['supermercado', 5000], ['combustible', 3000]]);
  assert.equal(r.movements.length, 5);
  assert.ok(r.movements.every((m) => m.group !== 'interno'));
  assert.deepEqual(r.sources, { cartola: 3, gmail: 2 });
  assert.deepEqual(monthsAvailable(s), ['2026-10']);
});

test('ledger collections survive normalization (sync and backup import)', () => {
  const s = normalizeState({
    statements: [{ id: 'stmt:1:2026-01-01', account: '1', accountType: 'Cuenta Vista', from: '2026-01-01', to: '2026-01-31', junk: 1 }],
    bankMovements: [{ id: 'm', date: '2026-01-02', amount: '10', direction: 'sideways', description: 'X', account: '1', source: 'cartola', kind: '' }],
  });
  assert.deepEqual(s.statements[0], { id: 'stmt:1:2026-01-01', account: '1', accountType: 'Cuenta Vista', from: '2026-01-01', to: '2026-01-31' });
  assert.equal(s.bankMovements[0].amount, 10);
  assert.equal(s.bankMovements[0].direction, 'out');
});
