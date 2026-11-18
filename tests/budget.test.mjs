import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, antAlerts, payoffMonths, shoppingList } from '../js/budget.js';
import { createEmptyState } from '../js/store.js';
import { parsePayslipText } from '../js/payslip.js';
import { OCTOBER_2026, AUGUST_2026 } from './fixtures.mjs';
import { CATALOG } from '../js/food.js';

function baseState() {
  const s = createEmptyState();
  s.payslips.push({ id: 'p8', ...parsePayslipText(AUGUST_2026) });
  s.fixedExpenses.push(
    { id: 'f1', name: 'Servicios básicos', amount: 60000, kind: 'fixed' },
    { id: 'f2', name: 'Petróleo', amount: 150000, kind: 'envelope', category: 'combustible' },
  );
  s.debts.push(
    { id: 'd1', name: 'Moto', type: 'loan', balance: null, payment: 200000 },
    { id: 'c1', name: 'CMR', type: 'card', balance: 500000, payment: 80000 },
    { id: 'c2', name: 'Tenpo', type: 'card', balance: 300000, payment: 80000 },
    { id: 'c3', name: 'MACH', type: 'card', balance: null, payment: 80000 },
  );
  return s;
}

test('plan follows the agreed 30% scheme with cards counting toward it', () => {
  const plan = computePlan(baseState(), '2026-11-01');
  // Falls back to the latest payslip (August): net pay + the advance from settings (120.000).
  assert.equal(plan.income, 1678220 + 120000);
  assert.equal(plan.target, Math.round((1678220 + 120000) * 0.3));
  assert.equal(plan.cardPayments, 240000);
  assert.equal(plan.emergency, plan.target - 240000);
  assert.equal(plan.fixedTotal, 60000 + 150000 + 200000);
  assert.equal(plan.spendable, 1678220 + 120000 - plan.target - 410000);
  assert.equal(plan.daysLeft, 29);
  assert.equal(plan.dailyAllowance, Math.floor(plan.spendable / 29));
  assert.equal(plan.status, 'green');
});

test('uses the payslip of the cycle salary period and sends the net bonus to savings', () => {
  const s = baseState();
  s.payslips.push({ id: 'p10', ...parsePayslipText(OCTOBER_2026) });
  const plan = computePlan(s, '2026-11-17');
  assert.equal(plan.salaryPeriod, '2026-10');
  assert.ok(plan.bonusNet > 200000);
  assert.equal(plan.income, 2010496 + 120000 - plan.bonusNet);
});

test('daily allowance redistributes savings and overspending over remaining days', () => {
  const s = baseState();
  const before = computePlan(s, '2026-11-17');
  s.expenses.push({ id: 'e1', date: '2026-11-16', amount: 1000, category: 'comida' });
  const under = computePlan(s, '2026-11-17');
  assert.ok(under.dailyAllowance < before.dailyAllowance);
  assert.equal(under.dailyAllowance, Math.floor((before.spendable - 1000) / 13));
  s.expenses.push({ id: 'e2', date: '2026-11-17', amount: under.dailyAllowance + 1, category: 'ocio' });
  const today = computePlan(s, '2026-11-17');
  assert.equal(today.status, 'red');
  assert.equal(today.remainingToday, -1);
});

test('yellow when today spending reaches 80% of the daily allowance', () => {
  const s = baseState();
  const p = computePlan(s, '2026-11-17');
  s.expenses.push({ id: 'e', date: '2026-11-17', amount: Math.ceil(p.dailyAllowance * 0.85), category: 'comida' });
  assert.equal(computePlan(s, '2026-11-17').status, 'yellow');
});

test('envelope spending only hits the daily budget when it exceeds the envelope', () => {
  const s = baseState();
  const p0 = computePlan(s, '2026-11-17');
  s.expenses.push({ id: 'e1', date: '2026-11-05', amount: 100000, category: 'combustible' });
  assert.equal(computePlan(s, '2026-11-17').dailyAllowance, p0.dailyAllowance);
  s.expenses.push({ id: 'e2', date: '2026-11-10', amount: 63000, category: 'combustible' });
  assert.equal(computePlan(s, '2026-11-17').dailyAllowance, Math.floor((p0.spendable - 13000) / 13));
});

test('paid-off cards free money toward real savings', () => {
  const s = baseState();
  s.debts.find((d) => d.id === 'c1').balance = 0;
  const plan = computePlan(s, '2026-11-17');
  assert.equal(plan.cardPayments, 160000);
  assert.equal(plan.emergency, plan.target - 160000);
});

test('deleted records are ignored', () => {
  const s = baseState();
  s.expenses.push({ id: 'e1', date: '2026-11-16', amount: 50000, category: 'comida', deleted: true });
  assert.equal(computePlan(s, '2026-11-17').spentInCycle, 0);
});

test('weekly food budget for today', () => {
  const s = baseState();
  const p = computePlan(s, '2026-11-17'); // Tuesday
  const weekly = Math.round((p.spendable / p.days) * s.settings.foodShare * 7);
  assert.equal(p.foodWeekBudget, weekly);
  // Monday passed with no food spending: the week budget spreads over the 6 days left.
  assert.equal(p.foodToday, Math.floor(weekly / 6));
  s.expenses.push({ id: 'e', date: '2026-11-16', amount: 20000, category: 'supermercado' });
  assert.equal(computePlan(s, '2026-11-17').foodToday, Math.floor((weekly - 20000) / 6));
});

test('ant spending alerts', () => {
  const ex = [];
  for (let i = 0; i < 5; i++) ex.push({ id: `s${i}`, date: '2026-11-1' + i, amount: 2500, category: 'comida', note: 'café' });
  ex.push({ id: 'd1', date: '2026-11-13', amount: 9000, category: 'delivery' });
  ex.push({ id: 'd2', date: '2026-11-14', amount: 11000, category: 'delivery' });
  const alerts = antAlerts(ex, '2026-11-15', 5000);
  const kinds = alerts.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['delivery', 'repeated', 'small']);
  assert.equal(alerts.find((a) => a.kind === 'small').total, 12500);
  assert.equal(alerts.find((a) => a.kind === 'delivery').total, 20000);
});

test('payoff months with and without interest', () => {
  assert.equal(payoffMonths(400000, 80000, 0), 5);
  assert.equal(payoffMonths(400000, 80000, null), 5);
  assert.equal(payoffMonths(100000, 1000, 3), Infinity);
  const n = payoffMonths(500000, 80000, 3);
  assert.ok(n >= 7 && n <= 8);
});

test('shopping list fits the weekly budget', () => {
  const big = shoppingList(CATALOG, 60000);
  assert.ok(big.total <= 60000);
  const small = shoppingList(CATALOG, 20000);
  assert.ok(small.total <= 20000);
  assert.ok(small.items.length < big.items.length || small.total < big.total);
  assert.ok(small.items.every((i) => i.qty > 0));
});

test('installment debts are commitments: counted as fixed, payoff by remaining installments', async () => {
  const { debtPayoff } = await import('../js/budget.js');
  const s = baseState();
  s.debts.push({ id: 'i1', name: 'Entel iPhone', type: 'installments', payment: 33739, installmentsLeft: 5 });
  s.debts.push({ id: 'i2', name: 'Entel DualSense', type: 'installments', payment: 3921, installmentsLeft: 0 });
  const plan = computePlan(s, '2026-11-17');
  assert.equal(plan.fixedTotal, 60000 + 150000 + 200000 + 33739);
  assert.equal(plan.cardPayments, 240000);
  assert.deepEqual(debtPayoff(s.debts.find((d) => d.id === 'i1')), { months: 5, remaining: 168695 });
  assert.deepEqual(debtPayoff({ type: 'card', balance: 400000, payment: 80000 }), { months: 5, remaining: 400000 });
  assert.deepEqual(debtPayoff({ type: 'card', balance: null, payment: 80000 }), { months: null, remaining: null });
});
