// Bank notification emails -> movements. Pure functions (no DOM, no network) so they
// run in the browser and under node:test. Formats observed in Banco de Chile emails.
import { live } from './store.js';
import { isDebtActive } from './budget.js';
import { addDays, daysBetween } from './cycle.js';

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', deg: '°', ordm: 'º', ordf: 'ª',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  zwj: '', zwnj: '', lrm: '', rlm: '', shy: '',
};

// Malformed numeric entities (beyond U+10FFFF) are dropped: String.fromCodePoint would throw.
const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/** Flattens email HTML to text: table cells become " | ", rows and breaks become new lines. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<br\s*\/?>|<\/(?:tr|p|div|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENTITIES ? ENTITIES[n] : m))
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const pesos = (s) => Number(String(s).replace(/\./g, ''));

function longDate(text) {
  const m = /(\d{1,2}) de ([a-záéíóú]+)(?: de)? (\d{4})/i.exec(text);
  const month = m && MONTHS[m[2].toLowerCase()];
  return month ? isoDate(m[3], month, m[1]) : null;
}

// The sender address (inside <...> when a display name is present) must end in the bank's domain,
// so "x@bancochile.cl.evil.com" or a display name that merely contains the bank address are rejected.
function bankOf(from) {
  const raw = String(from ?? '');
  const address = (/<([^<>]+)>\s*$/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
  if (/^[^\s@<>"]+@(?:[\w-]+\.)*bancochile\.cl$/.test(address)) return 'Banco de Chile';
  if (/^[^\s@<>"]+@(?:[\w-]+\.)*bancoestado\.cl$/.test(address)) return 'BancoEstado';
  return null;
}

/**
 * email: { id, from, subject, date (ISO timestamp), text (plain text or htmlToText output) }
 * Returns { ref, bank, kind: purchase|transfer|bill|loan, amount, date, description, ... } or null
 * for anything that is not money leaving the account.
 */
export function parseBankEmail(email) {
  const bank = bankOf(email.from);
  if (!bank) return null;
  const subject = String(email.subject ?? '');
  const text = String(email.text ?? '');
  const flat = text.replace(/\s+/g, ' ');
  const both = `${subject} ${flat}`;
  const base = { ref: `gmail:${email.id}`, bank };
  let out = null;

  const purchase = /compra por \$\s?([\d.]+) con cargo a (?:Cuenta|Tarjeta)[^*]*\*+(\d+) en (.+?) el (\d{2})\/(\d{2})\/(\d{4})/i.exec(flat);
  if (purchase) {
    const [, amount, account, merchant, d, m, y] = purchase;
    out = { ...base, kind: 'purchase', amount: pesos(amount), date: isoDate(y, m, d), description: merchant.trim(), account };
  } else if (/transferencia a terceros/i.test(both)) {
    const beneficiary = /Nombre y Apellido\s*\|\s*([^|\n]+?)\s*\|/i.exec(text)?.[1]?.trim() ?? '';
    const amount = /\bMonto\s*\|\s*\$\s*([\d.]+)/i.exec(text)?.[1];
    out = {
      ...base, kind: 'transfer', amount: amount ? pesos(amount) : 0, date: longDate(flat),
      description: beneficiary ? `Transferencia a ${beneficiary}` : 'Transferencia a terceros', beneficiary,
    };
  } else if (/pago de comercios|comprobante de pago electr[oó]nico/i.test(both)) {
    const store = /Comercio\s*\|\s*([^|\n]+?)\s*\|/i.exec(text)?.[1]?.trim() ?? '';
    const amount = /Monto total\s*\|\s*\$\s*([\d.]+)/i.exec(text)?.[1];
    const items = [...text.matchAll(/^\|?\s*([^|\n$]+?)\s*\|\s*\$\s*[\d.]+\s*\|\s*\d+\s*\|/gm)].map((x) => x[1].trim());
    const name = store ? `Pago ${store}` : 'Pago de cuentas';
    out = {
      ...base, kind: 'bill', amount: amount ? pesos(amount) : 0, date: longDate(flat),
      description: items.length ? `${name}: ${items.join(', ')}` : name,
    };
  } else if (/pago de cuota/i.test(both)) {
    const amount = /Monto Pagado\s*\|\s*\$\s*([\d.]+)/i.exec(text)?.[1];
    const day = /el d[ií]a (\d{2})\/(\d{2})\/(\d{4})/i.exec(flat);
    const n = /N[°º]\s*Cuota\s*\|\s*(\d+)/i.exec(text)?.[1];
    out = {
      ...base, kind: 'loan', amount: amount ? pesos(amount) : 0, date: day ? isoDate(day[3], day[2], day[1]) : null,
      description: n ? `Cuota ${n} crédito de consumo` : 'Cuota crédito de consumo',
    };
  }

  if (!out || !(out.amount > 0)) return null;
  if (!out.account) {
    // First account number in the email is the source account ("Origen" comes before "Destino").
    const acc = /(?:N[º°o]\.? de Cuenta|Cuenta de cargo)\s*\|\s*([\d-]{6,})/i.exec(text)?.[1];
    if (acc) out.account = acc.replace(/\D/g, '').slice(-4);
  }
  if (!out.date) out.date = String(email.date ?? '').slice(0, 10) || null;
  return out.date ? out : null;
}

const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

const CATEGORY_RULES = [
  ['delivery', /RAPPI|PEDIDOS ?YA|UBER ?EATS|DIDI ?FOOD|JUSTO/],
  ['combustible', /COPEC|SHELL|PETROBRAS|ARAMCO|ENEX|TERPEL/],
  ['supermercado', /SUPER|LIDER|JUMBO|UNIMARC|TOTTUS|SANTA ISABEL|ACUENTA|MAYORISTA|ALVI\b/],
  ['salud', /FARMACIA|CRUZ VERDE|SALCOBRAND|AHUMADA|DR\.? SIMI|CLINICA|MEDIC/],
  ['transporte', /UBER|CABIFY|DIDI|METRO|\bBIP\b|AUTOPISTA|PEAJE|TURBUS|PULLMAN/],
  ['ocio', /CINEMARK|CINEPOLIS|\bCINE\b|STEAM|PLAYSTATION|NINTENDO|NETFLIX|SPOTIFY|BOTILLERIA/],
  ['comida', /EMPANADA|GRIDO|RESTAUR|SUSHI|PIZZA|CAFE|MCDONALD|BURGER|KFC|DOGGIS|PANADER|COMIDA|FUENTE DE SODA/],
];

/** Best-guess expense category for a merchant name; 'otros' when unknown. */
export function suggestCategory(merchant) {
  const m = normalize(merchant);
  return CATEGORY_RULES.find(([, re]) => re.test(m))?.[0] ?? 'otros';
}

const GENERIC_WORDS = new Set(['TARJETA', 'BANCO', 'CREDITO', 'CUENTA', 'CHILE', 'PAGO', 'DEL', 'LOS', 'LAS',
  'SPA', 'LTDA', 'LIMITADA', 'EIRL']);
const words = (s) => normalize(s).split(/[^A-Z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));

export function matchDebt(debts, name) {
  const target = new Set(words(name));
  if (!target.size) return null;
  return debts.find((d) => words(d.name).some((w) => target.has(w))) ?? null;
}

/**
 * Turns parsed movements into import rows with a default action, avoiding double counting:
 * - emails already imported (even if that record was later deleted) are dropped;
 * - bill payments and loan installments default to "skip" (fixed expenses/debts already count them);
 * - transfers to a known debt default to a payment of that debt;
 * - a manual expense with the same amount within one day defaults to "skip".
 * action: { type: 'expense', category } | { type: 'debt', debtId } | { type: 'skip' }
 */
export function planImport(movements, state) {
  const seen = new Set([
    ...[...(state.expenses || []), ...(state.debtPayments || [])].map((r) => r.ref),
    ...(state.importedRefs || []).map((r) => r.id),
  ].filter(Boolean));
  const manual = live(state.expenses).filter((e) => !e.ref);
  const debts = live(state.debts).filter(isDebtActive);
  const fresh = movements.filter((m) => !seen.has(m.ref));
  const debtFor = new Map(fresh.filter((m) => m.kind === 'transfer')
    .map((m) => [m.ref, matchDebt(debts, m.beneficiary)]).filter(([, d]) => d));
  // Pair manual expenses with same-day emails first, then with emails one day apart.
  const duplicateOf = new Map();
  const matched = new Set();
  for (const maxGap of [0, 1]) {
    for (const m of fresh) {
      if (duplicateOf.has(m.ref) || debtFor.has(m.ref) || m.kind === 'bill' || m.kind === 'loan') continue;
      const dup = manual.find((e) => !matched.has(e.id) && Number(e.amount) === m.amount
        && Math.abs(daysBetween(e.date, m.date)) <= maxGap);
      if (dup) { matched.add(dup.id); duplicateOf.set(m.ref, dup.id); }
    }
  }
  return fresh.map((m) => {
    if (m.kind === 'bill') return { ...m, action: { type: 'skip' }, reason: 'Pago de cuentas: ya está contado en tus gastos fijos.' };
    if (m.kind === 'loan') return { ...m, action: { type: 'skip' }, reason: 'Cuota de crédito: elige la deuda si quieres registrarla.' };
    const debt = debtFor.get(m.ref);
    if (debt) return { ...m, action: { type: 'debt', debtId: debt.id }, reason: `Pago de ${debt.name}` };
    if (duplicateOf.has(m.ref)) {
      return { ...m, action: { type: 'skip' }, duplicateOf: duplicateOf.get(m.ref), reason: 'Parece que ya lo anotaste a mano.' };
    }
    const category = m.kind === 'purchase' ? suggestCategory(m.description) : 'otros';
    return { ...m, action: { type: 'expense', category } };
  });
}

/** Gmail's base64url data (bodies and attachments) as bytes. */
export function base64UrlToBytes(data) {
  const b64 = String(data ?? '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Decodes Gmail's base64url body data using the part's charset. */
export function decodeBase64Url(data, charset = 'utf-8') {
  const bytes = base64UrlToBytes(data);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function leaves(part, out = []) {
  if (!part) return out;
  if (Array.isArray(part.parts) && part.parts.length) part.parts.forEach((p) => leaves(p, out));
  else out.push(part);
  return out;
}

function charsetOf(part) {
  const ct = (part.headers || []).find((h) => String(h.name).toLowerCase() === 'content-type')?.value ?? '';
  return /charset="?([\w-]+)/i.exec(ct)?.[1] ?? 'utf-8';
}

/** Text of a Gmail API message payload: text/plain when present, otherwise flattened text/html. */
export function messageBody(payload) {
  const all = leaves(payload).filter((p) => p.body?.data);
  const plain = all.find((p) => p.mimeType === 'text/plain');
  if (plain) return decodeBase64Url(plain.body.data, charsetOf(plain));
  const html = all.find((p) => p.mimeType === 'text/html');
  return html ? htmlToText(decodeBase64Url(html.body.data, charsetOf(html))) : '';
}

/** Gmail search for both banks since a date (one day of slack: Gmail evaluates after: in its own timezone). */
export function gmailQuery(fromISO) {
  return `{from:bancochile.cl from:bancoestado.cl} after:${addDays(fromISO, -1).replace(/-/g, '/')}`;
}
