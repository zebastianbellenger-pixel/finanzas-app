// Budget calculations: the agreed 30% scheme, daily allowance, traffic light,
// ant-spending alerts, debts and the weekly shopping list.
import { cycleFor, daysLeftInCycle, addDays, mondayOf, daysBetween } from './cycle.js';
import { summarize } from './payslip.js';
import { live } from './store.js';
import { FOOD_CATEGORIES } from './food.js';

const sumBy = (list, fn = (x) => x.amount) => list.reduce((a, x) => a + Number(fn(x) || 0), 0);

export function isDebtActive(d) {
  if (d.type === 'installments') return d.installmentsLeft == null || d.installmentsLeft > 0;
  return d.balance == null || d.balance > 0;
}

export function pickPayslip(payslips, salaryPeriod) {
  const list = live(payslips).filter((p) => p.period);
  const exact = list.find((p) => p.period === salaryPeriod);
  if (exact) return { payslip: exact, exact: true };
  const latest = [...list].sort((a, b) => b.period.localeCompare(a.period))[0];
  return { payslip: latest || null, exact: false };
}

export function computePlan(state, today) {
  const { settings } = state;
  const cycle = cycleFor(today, settings.advanceDay);
  const { payslip, exact } = pickPayslip(state.payslips, cycle.salaryPeriod);

  let income = 0;
  let bonusNet = 0;
  if (payslip) {
    const s = summarize(payslip);
    bonusNet = exact ? s.bonusNet : 0;
    income = s.realIncome - s.advance + Number(settings.advanceAmount || 0) - s.bonusNet;
  }
  if (settings.expectedIncome) income = Number(settings.expectedIncome);

  const debts = live(state.debts).filter(isDebtActive);
  const cards = debts.filter((d) => d.type === 'card');
  const otherDebts = debts.filter((d) => d.type !== 'card');
  const fixed = live(state.fixedExpenses);

  const target = Math.round(income * settings.savingsRate);
  const cardPayments = sumBy(cards, (d) => d.payment);
  const emergency = Math.max(0, target - cardPayments);
  const fixedTotal = sumBy(fixed) + sumBy(otherDebts, (d) => d.payment);
  const spendable = income - Math.max(target, cardPayments) - fixedTotal;

  const inCycle = live(state.expenses).filter((e) => e.date >= cycle.start && e.date <= cycle.end);
  const envelopes = fixed.filter((f) => f.kind === 'envelope' && f.category);
  const envelopeCats = new Set(envelopes.map((f) => f.category));
  const envelopeStatus = envelopes.map((f) => {
    const spent = sumBy(inCycle.filter((e) => e.category === f.category));
    return { id: f.id, name: f.name, category: f.category, budget: Number(f.amount), spent, overrun: Math.max(0, spent - f.amount) };
  });
  const overrun = sumBy(envelopeStatus, (e) => e.overrun);
  const daily = inCycle.filter((e) => !envelopeCats.has(e.category));

  const note = live(state.cycleNotes).find((n) => n.id === cycle.start);
  const openingSpent = Number(note?.openingSpent || 0);
  const spentBefore = openingSpent + sumBy(daily.filter((e) => e.date < today)) + overrun;
  const spentToday = sumBy(daily.filter((e) => e.date === today));
  const daysLeft = daysLeftInCycle(cycle, today);
  const available = spendable - spentBefore;
  const dailyAllowance = daysLeft > 0 ? Math.floor(Math.max(0, available) / daysLeft) : 0;
  const remainingToday = dailyAllowance - spentToday;

  let status = 'green';
  if (remainingToday < 0 || dailyAllowance <= 0) status = 'red';
  else if (spentToday >= dailyAllowance * 0.8) status = 'yellow';

  // Food: weekly envelope (Mon-Sun) so the weekly supermarket run does not wreck one day.
  const foodWeekBudget = Math.round((spendable / cycle.days) * settings.foodShare * 7);
  const weekStart = mondayOf(today);
  const isFood = (e) => FOOD_CATEGORIES.includes(e.category);
  const foodBefore = sumBy(live(state.expenses).filter((e) => isFood(e) && e.date >= weekStart && e.date < today));
  const foodSpentToday = sumBy(live(state.expenses).filter((e) => isFood(e) && e.date === today));
  const weekDaysLeft = 7 - daysBetween(weekStart, today);
  const foodTodayBudget = Math.floor(Math.max(0, foodWeekBudget - foodBefore) / weekDaysLeft);
  const foodToday = Math.min(foodTodayBudget - foodSpentToday, Math.max(0, remainingToday));

  const savedInCycle = sumBy(live(state.savings).filter((s) => s.date >= cycle.start && s.date <= cycle.end));
  const cardPaidInCycle = sumBy(live(state.debtPayments).filter((p) => p.date >= cycle.start && p.date <= cycle.end
    && cards.some((c) => c.id === p.debtId)));

  return {
    cycle,
    salaryPeriod: cycle.salaryPeriod,
    payslipPeriod: payslip?.period ?? null,
    payslipExact: exact,
    income,
    bonusNet,
    target,
    cardPayments,
    emergency,
    fixedTotal,
    spendable,
    days: cycle.days,
    daysLeft,
    openingSpent,
    spentInCycle: sumBy(inCycle),
    spentBefore,
    spentToday,
    available,
    dailyAllowance,
    baselineDaily: Math.floor(spendable / cycle.days),
    remainingToday,
    status,
    envelopeStatus,
    foodWeekBudget,
    foodTodayBudget,
    foodSpentToday,
    foodToday,
    savedInCycle,
    cardPaidInCycle,
  };
}

export function antAlerts(expenses, today, threshold = 5000) {
  const from = addDays(today, -6);
  const week = live(expenses).filter((e) => e.date >= from && e.date <= today);
  const alerts = [];
  const small = week.filter((e) => e.amount <= threshold && e.category !== 'combustible');
  if (small.length >= 5) {
    const total = sumBy(small);
    alerts.push({ kind: 'small', count: small.length, total, monthly: Math.round((total / 7) * 30) });
  }
  const delivery = week.filter((e) => e.category === 'delivery');
  if (delivery.length >= 2) {
    alerts.push({ kind: 'delivery', count: delivery.length, total: sumBy(delivery) });
  }
  const groups = new Map();
  for (const e of small) {
    const key = (e.note || '').trim().toLowerCase();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  for (const [note, list] of groups) {
    if (list.length >= 3) alerts.push({ kind: 'repeated', note, count: list.length, total: sumBy(list) });
  }
  return alerts;
}

/** Months to pay off a balance; monthlyRate is a percentage (e.g. 3 = 3% monthly). */
export function payoffMonths(balance, payment, monthlyRate) {
  if (!payment || payment <= 0) return Infinity;
  if (balance <= 0) return 0;
  const r = Number(monthlyRate || 0) / 100;
  if (!r) return Math.ceil(balance / payment);
  if (payment <= balance * r) return Infinity;
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
}

export function debtPayoff(d) {
  if (d.type === 'installments') {
    if (d.installmentsLeft == null) return { months: null, remaining: null };
    return { months: d.installmentsLeft, remaining: d.installmentsLeft * d.payment };
  }
  if (d.balance == null) return { months: null, remaining: null };
  return { months: payoffMonths(d.balance, d.payment, d.rate), remaining: d.balance };
}

/** Trim the weekly list (least important, most expensive first) until it fits. */
export function shoppingList(catalog, budget) {
  const items = catalog.map((i) => ({ ...i }));
  const total = () => items.reduce((a, i) => a + i.price * i.qty, 0);
  for (const priority of [3, 2, 1]) {
    while (total() > budget) {
      const candidates = items.filter((i) => i.priority === priority);
      if (!candidates.length) break;
      const worst = candidates.sort((a, b) => b.price * b.qty - a.price * a.qty)[0];
      if (worst.qty > 1) worst.qty -= 1;
      else items.splice(items.indexOf(worst), 1);
    }
  }
  return { items, total: total(), budget };
}
