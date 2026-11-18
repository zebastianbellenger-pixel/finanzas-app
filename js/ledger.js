// Bank ledger: movements read from cartolas and bank emails, grouped per calendar month.
// Separate from the daily budget: it answers "where did the money in my account go this month".
import { live } from './store.js';
import { isDebtActive } from './budget.js';
import { suggestCategory, matchDebt } from './bankmail.js';

/** Report groups that are not expense categories (labels shown in the UI). */
export const LEDGER_GROUPS = {
  deudas: { label: 'Tarjetas y créditos', icon: '💳' },
  cuentas: { label: 'Cuentas y servicios', icon: '🧾' },
  transferencias: { label: 'Transferencias', icon: '↗️' },
  comisiones: { label: 'Comisiones', icon: '🏦' },
};

const CARD_WORDS = /\bTARJETA\b|\bCMR\b|\bVISA\b|\bMASTERCARD\b|\bTENPO\b|\bMACH\b/i;
const BILLS = /SERVIPAG|RECAUDACION Y PAGOS|PAGO DE SERVICIOS|PAGO AUTOMATICO|\bPAC\b/i;
const FEES = /\bCOMISION|\bIMPUESTOS?\b|\bMANTENCION\b|\bINTERES(ES)?\b|SEGURO DESGRAVAMEN/i;
const LOANS = /CUOTA CREDITO|PAGO CREDITO|CREDITO CONSUMO|AMORTIZACION/i;
const INTERNAL = /TRASPASO (?:A|DE) CUENTA:/i;

/**
 * Group of a ledger movement: an expense category id, one of LEDGER_GROUPS,
 * 'ingreso' (money in) or 'interno' (between your own accounts, excluded from totals).
 */
export function classifyMovement(m, debts = []) {
  const text = String(m.description ?? '');
  if (INTERNAL.test(text)) return 'interno';
  if (m.direction === 'in') return 'ingreso';
  if (m.source === 'gmail') {
    if (m.kind === 'bill') return 'cuentas';
    if (m.kind === 'loan') return 'deudas';
    if (m.kind === 'transfer') {
      const who = m.beneficiary ?? text.replace(/^Transferencia a\s*/i, '');
      return CARD_WORDS.test(who) || matchDebt(debts, who) ? 'deudas' : 'transferencias';
    }
    return suggestCategory(text);
  }
  if (BILLS.test(text)) return 'cuentas';
  if (FEES.test(text)) return 'comisiones';
  if (LOANS.test(text)) return 'deudas';
  const transfer = /^TRASPASO A:\s*(.*)$/i.exec(text);
  if (transfer) return CARD_WORDS.test(transfer[1]) || matchDebt(debts, transfer[1]) ? 'deudas' : 'transferencias';
  return suggestCategory(text.replace(/^PAGO:\s*/i, ''));
}

/** Statement + movement records with content-based ids: re-importing or overlapping statements never duplicates. */
export function cartolaRecords(parsed) {
  const seen = new Map();
  const movements = parsed.movements.map((m) => {
    const key = `cartola:${parsed.account}:${m.date}:${m.direction}:${m.amount}:${m.description}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return {
      id: `${key}:${n}`, date: m.date, amount: m.amount, direction: m.direction, description: m.description,
      account: parsed.account, source: 'cartola', kind: '',
    };
  });
  return {
    statement: { id: `stmt:${parsed.account}:${parsed.from}`, account: parsed.account, accountType: parsed.accountType, from: parsed.from, to: parsed.to },
    movements,
  };
}

/** Ledger records for movements parsed from bank emails (id = email ref). */
export function emailRecords(movements) {
  return movements.map((m) => ({
    id: m.ref, date: m.date, amount: m.amount, direction: 'out', description: m.description,
    account: m.account || '', source: 'gmail', kind: m.kind,
  }));
}

/**
 * Monthly report for 'YYYY-MM'. Cartola movements are authoritative: an email movement is only
 * counted when no imported cartola covers its account and date (a statement covers (from, to]).
 */
export function monthlyReport(state, month) {
  const statements = live(state.statements);
  const debts = live(state.debts).filter(isDebtActive);
  const covered = (m) => statements.some((s) => (!m.account || s.account === m.account) && m.date > s.from && m.date <= s.to);
  const movements = live(state.bankMovements)
    .filter((m) => String(m.date).startsWith(month))
    .filter((m) => m.source === 'cartola' || !covered(m))
    .map((m) => ({ ...m, group: classifyMovement(m, debts) }))
    .filter((m) => m.group !== 'interno')
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
  const outs = movements.filter((m) => m.direction === 'out');
  const totals = new Map();
  for (const m of outs) totals.set(m.group, (totals.get(m.group) || 0) + m.amount);
  return {
    month,
    out: outs.reduce((a, m) => a + m.amount, 0),
    in: movements.filter((m) => m.direction === 'in').reduce((a, m) => a + m.amount, 0),
    groups: [...totals].map(([id, value]) => ({ id, value })).sort((a, b) => b.value - a.value),
    movements,
    sources: {
      cartola: movements.filter((m) => m.source === 'cartola').length,
      gmail: movements.filter((m) => m.source === 'gmail').length,
    },
  };
}

/** Months with ledger data, newest first. */
export function monthsAvailable(state) {
  return [...new Set(live(state.bankMovements).map((m) => String(m.date).slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))]
    .sort().reverse();
}
