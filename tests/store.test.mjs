import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, mergeStates, normalizeState, encodeBase64Utf8, decodeBase64Utf8 } from '../js/store.js';

test('merge keeps the newest version of each record and unions the rest', () => {
  const a = createEmptyState();
  const b = createEmptyState();
  a.expenses.push({ id: 'x', amount: 1000, updatedAt: 10 }, { id: 'onlyA', amount: 5, updatedAt: 1 });
  b.expenses.push({ id: 'x', amount: 2000, updatedAt: 20 }, { id: 'onlyB', amount: 7, updatedAt: 1 });
  const m = mergeStates(a, b);
  assert.equal(m.expenses.length, 3);
  assert.equal(m.expenses.find((e) => e.id === 'x').amount, 2000);
});

test('merge propagates deletions (tombstones win when newer)', () => {
  const a = createEmptyState();
  const b = createEmptyState();
  a.debts.push({ id: 'd', name: 'CMR', updatedAt: 5 });
  b.debts.push({ id: 'd', name: 'CMR', deleted: true, updatedAt: 9 });
  assert.equal(mergeStates(a, b).debts[0].deleted, true);
});

test('merge takes newer settings object', () => {
  const a = createEmptyState();
  const b = createEmptyState();
  a.settings = { ...a.settings, foodShare: 0.4, updatedAt: 3 };
  b.settings = { ...b.settings, foodShare: 0.6, updatedAt: 8 };
  assert.equal(mergeStates(a, b).settings.foodShare, 0.6);
  assert.equal(mergeStates(b, a).settings.foodShare, 0.6);
});

test('merge tolerates collections missing on one side', () => {
  const a = createEmptyState();
  const b = { settings: { updatedAt: 0 } };
  assert.deepEqual(mergeStates(a, b).weights, []);
});

test('base64 round-trips UTF-8 text', () => {
  const text = 'Liquidación — $ 1.234.567 ñ';
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(text)), text);
});

test('normalizeState coerces imported/synced fields to safe types', async () => {
  const { normalizeState } = await import('../js/store.js');
  const evil = '<img src=x onerror=alert(1)>';
  const s = normalizeState({
    settings: { deliveryPrice: evil, savingsRate: '0.2', expectedIncome: '', updatedAt: '5' },
    debts: [{ id: 7, name: 'CMR', type: evil, payment: evil, balance: '1000', installmentsLeft: null, dueDay: '6', updatedAt: 1, extra: evil }],
    expenses: [{ id: 'e', date: '2026-11-17', amount: '2500', category: 'comida', note: 3, createdAt: '9' }],
    weights: [{ id: '2026-11-16', kg: evil }],
    payslips: [{ id: 'p', period: '2026-10', netPay: '900', items: [{ id: 1, section: 'taxable', label: 9, amount: '5', kind: 'bonus' }], sectionTotals: { taxable: '5' } }],
    cycleNotes: [{ id: '2026-10-30', openingSpent: evil }],
  });
  assert.equal(s.settings.deliveryPrice, 9000); // invalid number falls back to default
  assert.equal(s.settings.savingsRate, 0.2);
  assert.equal(s.settings.expectedIncome, null);
  const d = s.debts[0];
  assert.equal(d.id, '7');
  assert.equal(d.type, 'loan');
  assert.equal(d.payment, 0);
  assert.equal(d.balance, 1000);
  assert.equal(d.installmentsLeft, null);
  assert.equal(d.dueDay, 6);
  assert.equal('extra' in d, false);
  assert.equal(s.expenses[0].amount, 2500);
  assert.equal(s.expenses[0].note, '3');
  assert.equal(s.weights[0].kg, 0);
  assert.equal(s.payslips[0].netPay, 900);
  assert.deepEqual(s.payslips[0].items[0], { id: '1', section: 'taxable', label: '9', amount: 5, kind: 'bonus' });
  assert.equal(s.payslips[0].sectionTotals.taxable, 5);
  assert.equal(s.cycleNotes[0].openingSpent, 0);
});

test('merging a sync result with edits made meanwhile keeps both', () => {
  const before = createEmptyState();
  before.expenses.push({ id: 'A', amount: 1, updatedAt: 1 });
  const syncResult = mergeStates(before, createEmptyState());
  // While the request was in flight the user added B and changed a setting.
  const current = normalizeState(before);
  current.expenses.push({ id: 'B', amount: 2, updatedAt: 5 });
  current.settings = { ...current.settings, savingsRate: 0.25, updatedAt: 5 };
  const final = mergeStates(syncResult, current);
  assert.deepEqual(final.expenses.map((e) => e.id).sort(), ['A', 'B']);
  assert.equal(final.settings.savingsRate, 0.25);
});

test('normalizeState keeps Gmail import references and the imported-refs collection', () => {
  const s = normalizeState({
    expenses: [{ id: 'e1', date: '2026-11-18', amount: 1000, category: 'otros', ref: 'gmail:abc' }],
    debtPayments: [{ id: 'p1', debtId: 'c1', date: '2026-11-18', amount: 80000, ref: 'gmail:def' }],
    importedRefs: [{ id: 'gmail:ghi', updatedAt: 5, junk: '<script>' }],
  });
  assert.equal(s.expenses[0].ref, 'gmail:abc');
  assert.equal(s.debtPayments[0].ref, 'gmail:def');
  assert.deepEqual(s.importedRefs, [{ id: 'gmail:ghi', updatedAt: 5 }]);
  assert.equal('ref' in normalizeState({ expenses: [{ id: 'e2', amount: 1 }] }).expenses[0], false);
});
