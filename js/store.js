// Local persistence and merge logic for multi-device sync.

export const STORAGE_KEY = 'finanzas.v1';
export const COLLECTIONS = [
  'payslips', 'fixedExpenses', 'debts', 'debtPayments', 'expenses',
  'savings', 'weights', 'homeMeals', 'cycleNotes',
];

export function createEmptyState() {
  const state = {
    version: 1,
    settings: {
      savingsRate: 0.3,
      foodShare: 0.5,
      advanceAmount: 120000,
      advanceDay: 15,
      expectedIncome: null,
      antThreshold: 5000,
      deliveryPrice: 9000,
      homeMealCost: 1500,
      prices: {},
      updatedAt: 0,
    },
  };
  for (const c of COLLECTIONS) state[c] = [];
  return state;
}

// Field schemas: imported backups and synced files are untrusted, so every record
// is rebuilt with known fields coerced to their types (unknown fields are dropped).
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const oneOf = (values, fallback) => (v) => (values.includes(v) ? v : fallback);

const COMMON = { id: str, updatedAt: num, deleted: (v) => v === true };
const SECTIONS = ['taxable', 'nonTaxable', 'legal', 'other'];
const ITEM = { id: str, section: oneOf(SECTIONS, 'other'), label: str, amount: num, kind: str };
const SCHEMAS = {
  payslips: {
    source: str, period: strOrNull, netPay: numOrNull, contractBase: numOrNull, taxableBase: numOrNull,
    totalEarnings: numOrNull, totalDeductions: numOrNull, healthSystem: strOrNull,
    sectionTotals: (v) => Object.fromEntries(SECTIONS.filter((s) => v && v[s] != null).map((s) => [s, num(v[s])])),
    items: (v) => (Array.isArray(v) ? v.map((i) => coerce(i, ITEM, false)) : []),
  },
  fixedExpenses: {
    name: str, amount: num, dueDay: numOrNull, kind: oneOf(['fixed', 'envelope'], 'fixed'), category: strOrNull,
  },
  debts: {
    name: str, type: oneOf(['card', 'loan', 'installments'], 'loan'), payment: num, balance: numOrNull,
    installmentsLeft: numOrNull, rate: numOrNull, dueDay: numOrNull,
  },
  debtPayments: { debtId: str, date: str, amount: num },
  expenses: { date: str, amount: num, category: str, note: str, createdAt: num },
  savings: { date: str, amount: num, kind: str, cycle: str },
  weights: { kg: num },
  homeMeals: { date: str },
  cycleNotes: { openingSpent: num },
};

function coerce(rec, schema, withCommon = true) {
  const src = rec && typeof rec === 'object' ? rec : {};
  const fields = withCommon ? { ...COMMON, ...schema } : schema;
  const out = {};
  for (const [key, fn] of Object.entries(fields)) {
    if (key in src || key === 'id') out[key] = fn(src[key]);
  }
  if (!withCommon) return out;
  if (!out.deleted) delete out.deleted;
  return out;
}

function coerceSettings(raw, defaults) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults };
  for (const key of ['savingsRate', 'foodShare', 'advanceAmount', 'advanceDay', 'antThreshold',
    'deliveryPrice', 'homeMealCost', 'updatedAt']) {
    const n = numOrNull(s[key]);
    if (n !== null) out[key] = n;
  }
  out.expectedIncome = numOrNull(s.expectedIncome);
  out.prices = Object.fromEntries(Object.entries(s.prices && typeof s.prices === 'object' ? s.prices : {})
    .map(([k, v]) => [String(k), numOrNull(v)]).filter(([, v]) => v !== null && v > 0));
  return out;
}

export function normalizeState(raw) {
  const base = createEmptyState();
  if (!raw || typeof raw !== 'object') return base;
  const state = { ...base, settings: coerceSettings(raw.settings, base.settings) };
  for (const c of COLLECTIONS) {
    state[c] = Array.isArray(raw[c]) ? raw[c].map((r) => coerce(r, SCHEMAS[c])).filter((r) => r.id) : [];
  }
  return state;
}

function mergeCollection(a = [], b = []) {
  const map = new Map();
  for (const item of [...a, ...b]) {
    const prev = map.get(item.id);
    if (!prev || (item.updatedAt || 0) > (prev.updatedAt || 0)) map.set(item.id, item);
  }
  return [...map.values()];
}

/** Record-level last-writer-wins merge; deletions are tombstones (deleted: true). */
export function mergeStates(a, b) {
  const left = normalizeState(a);
  const right = normalizeState(b);
  const merged = normalizeState(left);
  merged.settings = (right.settings.updatedAt || 0) > (left.settings.updatedAt || 0)
    ? right.settings
    : left.settings;
  for (const c of COLLECTIONS) merged[c] = mergeCollection(left[c], right[c]);
  return merged;
}

export function live(list) {
  return (list || []).filter((x) => !x.deleted);
}

export function loadLocal(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return normalizeState(raw ? JSON.parse(raw) : null);
  } catch {
    return createEmptyState();
  }
}

export function saveLocal(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

let idSeq = 0;
export function newId(prefix = 'r') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${(idSeq++).toString(36)}`;
}
