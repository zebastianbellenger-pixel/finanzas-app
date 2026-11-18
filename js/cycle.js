// Pay cycle and Chilean holiday calendar. Dates are ISO strings (YYYY-MM-DD)
// handled in UTC to avoid timezone drift.

const pad = (n) => String(n).padStart(2, '0');

export function iso(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function toDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDate(date) {
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(isoDate, n) {
  const d = toDate(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDate(d);
}

export function weekday(isoDate) {
  return toDate(isoDate).getUTCDay(); // 0 Sunday .. 6 Saturday
}

export function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

export function todayISO(now = new Date()) {
  return iso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function easterSunday(year) {
  // Anonymous Gregorian algorithm.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

// Law 19.668: Tue/Wed/Thu move to the Monday of that week, Friday to the next Monday.
function movedToMonday(isoDate) {
  const wd = weekday(isoDate);
  if (wd >= 2 && wd <= 4) return addDays(isoDate, 1 - wd);
  if (wd === 5) return addDays(isoDate, 3);
  return isoDate;
}

// Law 20.663: Oct 31 on Tuesday moves to previous Friday, on Wednesday to next Friday.
function evangelicalChurchesDay(year) {
  const d = iso(year, 10, 31);
  const wd = weekday(d);
  if (wd === 2) return addDays(d, -4);
  if (wd === 3) return addDays(d, 2);
  return d;
}

const INDIGENOUS_DAY = { 2025: 20, 2026: 21, 2027: 21, 2028: 20, 2029: 21, 2030: 21 };

const cache = new Map();

export function chileHolidays(year) {
  if (cache.has(year)) return cache.get(year);
  const easter = easterSunday(year);
  const set = new Set([
    iso(year, 1, 1),
    addDays(easter, -2), // Good Friday
    addDays(easter, -1), // Holy Saturday
    iso(year, 5, 1),
    iso(year, 5, 21),
    iso(year, 6, INDIGENOUS_DAY[year] ?? 21),
    movedToMonday(iso(year, 6, 29)),
    iso(year, 7, 16),
    iso(year, 8, 15),
    iso(year, 9, 18),
    iso(year, 9, 19),
    movedToMonday(iso(year, 10, 12)),
    evangelicalChurchesDay(year),
    iso(year, 11, 1),
    iso(year, 12, 8),
    iso(year, 12, 25),
  ]);
  cache.set(year, set);
  return set;
}

export function isBusinessDay(isoDate) {
  const wd = weekday(isoDate);
  if (wd === 0 || wd === 6) return false;
  return !chileHolidays(Number(isoDate.slice(0, 4))).has(isoDate);
}

/** month is 1-12 */
export function lastBusinessDayOfMonth(year, month) {
  const next = month === 12 ? iso(year + 1, 1, 1) : iso(year, month + 1, 1);
  let d = addDays(next, -1);
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

function shiftMonth(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

/**
 * The cycle containing `date`: from the salary payday (last business day of a month)
 * to the day before the next payday. The advance (anticipo) is paid on the 15th inside it.
 */
export function cycleFor(date, advanceDay = 15) {
  let [y, m] = date.split('-').map(Number);
  let start = lastBusinessDayOfMonth(y, m);
  if (date < start) {
    [y, m] = shiftMonth(y, m, -1);
    start = lastBusinessDayOfMonth(y, m);
  }
  const [ny, nm] = shiftMonth(y, m, 1);
  const nextPayday = lastBusinessDayOfMonth(ny, nm);
  const end = addDays(nextPayday, -1);
  return {
    start,
    end,
    nextPayday,
    advanceDate: iso(ny, nm, advanceDay),
    salaryPeriod: `${y}-${pad(m)}`,
    days: daysBetween(start, nextPayday),
  };
}

export function daysLeftInCycle(cycle, date) {
  return daysBetween(date, cycle.nextPayday);
}

export function mondayOf(isoDate) {
  const wd = weekday(isoDate);
  return addDays(isoDate, wd === 0 ? -6 : 1 - wd);
}
