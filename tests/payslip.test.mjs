import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayslipText, summarize, wordsToText } from '../js/payslip.js';
import { AUGUST_2026, SEPTEMBER_2026, OCTOBER_2026 } from './fixtures.mjs';

test('parses August 2026 Buk payslip', () => {
  const p = parsePayslipText(AUGUST_2026);
  assert.equal(p.period, '2026-08');
  assert.equal(p.netPay, 1678220);
  assert.equal(p.contractBase, 1372800);
  assert.equal(p.healthSystem, 'Fonasa');
  assert.deepEqual(p.warnings, []);
  const s = summarize(p);
  assert.equal(s.baseSalary, 1346106);
  assert.equal(s.gratification, 342246);
  assert.equal(s.overtime, 22880);
  assert.equal(s.bonuses, 0);
  assert.equal(s.allowances, 560000);
  assert.equal(s.reimbursementsIn, 14000);
  assert.equal(s.reimbursementsOut, 14000);
  assert.equal(s.afp, 181048);
  assert.equal(s.health, 119786);
  assert.equal(s.unemployment, 10268);
  assert.equal(s.incomeTax, 0);
  assert.equal(s.advance, 240000);
  assert.equal(s.otherDeductions, 41910);
  assert.equal(s.taxableTotal, 1711232);
  assert.equal(s.legalTotal, 311102);
  assert.equal(s.realIncome, 1918220);
  assert.equal(s.recurringIncome, 1918220);
});

test('parses September 2026: two overtime lines and petty cash reimbursement', () => {
  const p = parsePayslipText(SEPTEMBER_2026);
  assert.equal(p.period, '2026-09');
  assert.deepEqual(p.warnings, []);
  const s = summarize(p);
  assert.equal(s.overtime, 125078);
  assert.equal(s.reimbursementsIn, 56160);
  assert.equal(s.reimbursementsOut, 35160);
  assert.equal(s.advance, 240000);
  assert.equal(s.realIncome, 1807646 + 240000 - 21000);
});

test('parses October 2026: bonus and payroll loan installment', () => {
  const p = parsePayslipText(OCTOBER_2026);
  assert.equal(p.period, '2026-10');
  assert.equal(p.netPay, 2010496);
  assert.deepEqual(p.warnings, []);
  const s = summarize(p);
  assert.equal(s.bonuses, 500000);
  assert.deepEqual(s.payrollLoans, [
    { label: 'Crédito Personal Caja Los Andes Cuota 1/3', amount: 145536, installment: 1, totalInstallments: 3 },
  ]);
  assert.equal(s.realIncome, 2250496);
  // Bonus net of legal deductions is excluded from recurring income.
  const legalRate = 417372 / 2295776;
  assert.equal(s.bonusNet, Math.round(500000 * (1 - legalRate)));
  assert.equal(s.recurringIncome, 2250496 - s.bonusNet);
});

test('warns when item sums do not match the section totals', () => {
  const broken = AUGUST_2026.replace('Gratificación $ 342.246', 'Gratificación $ 342.000');
  const p = parsePayslipText(broken);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /Haberes imponibles/);
});

test('summary follows manual corrections of items', () => {
  const p = parsePayslipText(AUGUST_2026);
  const fixed = { ...p, items: p.items.map((i) => (i.kind === 'gratification' ? { ...i, amount: 100000 } : i)) };
  assert.equal(summarize(fixed).gratification, 100000);
});

test('parses OCR-like lines without spaces after the peso sign', () => {
  const p = parsePayslipText('Mes: Octubre 2026\nHABERES IMPONIBLES $1.000\nSueldo Base $1.000\nLIQUIDO A PAGAR: $900');
  assert.equal(p.netPay, 900);
  assert.equal(summarize(p).baseSalary, 1000);
});

test('wordsToText groups rows and emits left column before right column', () => {
  const words = [
    { text: 'Sueldo', x: 80, y: 424 }, { text: 'Base', x: 130, y: 425 }, { text: '$ 673.053', x: 390, y: 424 },
    { text: 'Cotiz.', x: 483, y: 424 }, { text: 'Salud', x: 520, y: 424 }, { text: '$ 59.893', x: 790, y: 425 },
    { text: 'Gratificación', x: 80, y: 450 }, { text: '$ 171.123', x: 390, y: 451 },
  ];
  assert.equal(
    wordsToText(words, 920),
    'Sueldo Base $ 673.053\nGratificación $ 171.123\n---\nCotiz. Salud $ 59.893'
    + '\n===\nSueldo Base $ 673.053 Cotiz. Salud $ 59.893\nGratificación $ 171.123',
  );
});

test('finds the net pay when its label and amount fall in different columns (real Buk PDF layout)', () => {
  // Real Buk PDFs (595pt wide): "LÍQUIDO A RECIBIR:" at the left, the amount beyond the middle.
  const words = [
    { text: 'Mes: Agosto 2026', x: 40, y: 100 },
    { text: 'HABERES IMPONIBLES', x: 60, y: 260 }, { text: '$ 1.711.232', x: 250, y: 260 },
    { text: 'Sueldo Base', x: 50, y: 275 }, { text: '$ 1.711.232', x: 255, y: 275 },
    { text: 'TOTAL HABERES $ 1.711.232', x: 100, y: 410 },
    { text: 'LÍQUIDO A RECIBIR:', x: 230, y: 460 }, { text: '$ 1.678.220', x: 310, y: 460 },
  ];
  const p = parsePayslipText(wordsToText(words, 595));
  assert.equal(p.netPay, 1678220);
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.warnings, []);
});
