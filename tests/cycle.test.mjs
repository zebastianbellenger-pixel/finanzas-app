import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chileHolidays, lastBusinessDayOfMonth, cycleFor, daysLeftInCycle, addDays,
} from '../js/cycle.js';

test('last business day of month skips weekends', () => {
  assert.equal(lastBusinessDayOfMonth(2026, 10), '2026-10-30'); // Oct 31 2026 is Saturday
  assert.equal(lastBusinessDayOfMonth(2026, 11), '2026-11-30');
  assert.equal(lastBusinessDayOfMonth(2026, 12), '2026-12-31');
  assert.equal(lastBusinessDayOfMonth(2027, 1), '2027-01-29'); // Jan 31 2027 is Sunday
});

test('last business day of month skips Chilean holidays', () => {
  // Oct 31 2025 (Friday) is Día de las Iglesias Evangélicas.
  assert.equal(lastBusinessDayOfMonth(2025, 10), '2025-10-30');
  // Good Friday 2024 was March 29.
  assert.equal(lastBusinessDayOfMonth(2024, 3), '2024-03-28');
});

test('holiday rules: Easter, moved holidays and Oct 31 rule', () => {
  const h2026 = chileHolidays(2026);
  assert.ok(h2026.has('2026-04-03')); // Good Friday 2026
  assert.ok(h2026.has('2026-04-04')); // Holy Saturday 2026
  assert.ok(h2026.has('2026-09-18'));
  assert.ok(h2026.has('2026-06-29')); // San Pedro y San Pablo, Monday
  assert.ok(h2026.has('2026-10-12')); // Monday
  assert.ok(chileHolidays(2028).has('2028-10-27')); // Oct 31 Tuesday -> previous Friday
  assert.ok(chileHolidays(2029).has('2029-11-02')); // Oct 31 Wednesday -> next Friday
  assert.ok(chileHolidays(2027).has('2027-06-28')); // June 29 2027 Tuesday -> Monday 28
});

test('cycle runs from last business day to the day before the next payday', () => {
  const c = cycleFor('2026-11-17');
  assert.equal(c.start, '2026-10-30');
  assert.equal(c.end, '2026-11-29');
  assert.equal(c.nextPayday, '2026-11-30');
  assert.equal(c.advanceDate, '2026-11-15');
  assert.equal(c.salaryPeriod, '2026-10');
  assert.equal(c.days, 31);
  assert.equal(daysLeftInCycle(c, '2026-11-17'), 13);
});

test('payday itself starts a new cycle', () => {
  const c = cycleFor('2026-11-30');
  assert.equal(c.start, '2026-11-30');
  assert.equal(c.salaryPeriod, '2026-11');
  assert.equal(c.nextPayday, '2026-12-31');
  assert.equal(c.end, '2026-12-30');
});

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
