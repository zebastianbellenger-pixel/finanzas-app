// Chilean payslip (liquidación de sueldo) parsing, tuned for Buk PDFs.
// Input text is produced by wordsToText(): left column lines, '---', right column lines.

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export const KIND_LABELS = {
  baseSalary: 'Sueldo base',
  gratification: 'Gratificación',
  overtime: 'Horas extras',
  bonus: 'Bono',
  otherTaxable: 'Otro haber imponible',
  allowance: 'Movilización / colación',
  reimbursement: 'Reembolso (viático, caja chica)',
  otherNonTaxable: 'Otro haber no imponible',
  afp: 'AFP',
  health: 'Salud (Fonasa/Isapre)',
  unemployment: 'Seguro de cesantía',
  incomeTax: 'Impuesto único',
  otherLegal: 'Otro descuento legal',
  advance: 'Anticipo',
  payrollLoan: 'Crédito por planilla',
  reimbursementOffset: 'Rendición (viático, caja chica)',
  otherDeduction: 'Otro descuento',
};

export const SECTION_LABELS = {
  taxable: 'Haberes imponibles',
  nonTaxable: 'Haberes no imponibles',
  legal: 'Descuentos legales',
  other: 'Otros descuentos',
};

export const SECTION_KINDS = {
  taxable: ['baseSalary', 'gratification', 'overtime', 'bonus', 'otherTaxable'],
  nonTaxable: ['allowance', 'reimbursement', 'otherNonTaxable'],
  legal: ['afp', 'health', 'unemployment', 'incomeTax', 'otherLegal'],
  other: ['advance', 'payrollLoan', 'reimbursementOffset', 'otherDeduction'],
};

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const toAmount = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;

/** Group positioned words into rows and emit left column, '---', right column. */
export function wordsToText(words, pageWidth, rowTolerance) {
  const tol = rowTolerance ?? Math.max(3, pageWidth * 0.005);
  const sorted = [...words].filter((w) => w.text && w.text.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const w of sorted) {
    const row = rows.find((r) => Math.abs(r.y - w.y) <= tol);
    if (row) row.words.push(w);
    else rows.push({ y: w.y, words: [w] });
  }
  const mid = pageWidth / 2;
  const left = [];
  const right = [];
  const full = [];
  for (const row of rows) {
    const ws = row.words.sort((a, b) => a.x - b.x);
    const l = ws.filter((w) => w.x < mid).map((w) => w.text.trim()).join(' ');
    const r = ws.filter((w) => w.x >= mid).map((w) => w.text.trim()).join(' ');
    if (l) left.push(l);
    if (r) right.push(r);
    full.push(ws.map((w) => w.text.trim()).join(' '));
  }
  // Full rows after '===' are only used for header/footer fields whose label and
  // amount straddle the column split (e.g. "LÍQUIDO A RECIBIR:  $ 1.234.567").
  return [...left, '---', ...right, '===', ...full].join('\n');
}

function sectionOf(line) {
  const f = fold(line);
  if (/^haberes no imponibles/.test(f)) return 'nonTaxable';
  if (/^haberes imponibles/.test(f)) return 'taxable';
  if (/^descuentos legales/.test(f)) return 'legal';
  if (/^otros descuentos/.test(f)) return 'other';
  return null;
}

const STOP = /^(total |imp\.|base trib|liquido|certifico|firma|---)/;

export function classify(section, label) {
  const f = fold(label);
  switch (section) {
    case 'taxable':
      if (/sueldo base/.test(f)) return 'baseSalary';
      if (/gratific/.test(f)) return 'gratification';
      if (/horas? extra/.test(f)) return 'overtime';
      if (/bono|comision|incentivo|aguinaldo|premio/.test(f)) return 'bonus';
      return 'otherTaxable';
    case 'nonTaxable':
      if (/viatico|caja chica|reembolso|rendicion/.test(f)) return 'reimbursement';
      if (/movilizacion|colacion|asignacion/.test(f)) return 'allowance';
      return 'otherNonTaxable';
    case 'legal':
      if (/previ|afp/.test(f)) return 'afp';
      if (/salud|fonasa|isapre/.test(f)) return 'health';
      if (/cesantia/.test(f)) return 'unemployment';
      if (/impuesto/.test(f)) return 'incomeTax';
      return 'otherLegal';
    case 'other':
      if (/viatico|caja chica|rendicion/.test(f)) return 'reimbursementOffset';
      if (/anticipo/.test(f)) return 'advance';
      if (/credito|prestamo|cuota/.test(f)) return 'payrollLoan';
      return 'otherDeduction';
    default:
      return 'otherDeduction';
  }
}

let seq = 0;
const newId = () => `i${Date.now().toString(36)}${(seq++).toString(36)}`;

export function parsePayslipText(rawText) {
  const text = rawText.replace(/ /g, ' ');
  const folded = fold(text);
  const items = [];
  const sectionTotals = {};
  let section = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '===') break; // full-row block: global fields only
    if (!line) continue;
    const head = sectionOf(line);
    if (head) {
      section = head;
      const m = line.match(/\$?\s*([\d.]+)\s*$/);
      if (m) sectionTotals[head] = toAmount(m[1]);
      continue;
    }
    if (STOP.test(fold(line))) {
      section = null;
      continue;
    }
    if (!section) continue;
    const m = line.match(/^(.*\S)\s+\$?\s*(\d{1,3}(?:\.\d{3})+|\d+)$/);
    if (!m) continue;
    const label = m[1].replace(/[\s$]+$/, '').trim();
    if (!/[a-z]/i.test(label)) continue;
    items.push({ id: newId(), section, label, amount: toAmount(m[2]), kind: classify(section, label) });
  }

  const grab = (re) => {
    const m = folded.match(re);
    return m ? toAmount(m[1]) : null;
  };
  const monthMatch = folded.match(/mes:\s*([a-z]+)\s+(\d{4})/);
  const period = monthMatch && MONTHS[monthMatch[1]]
    ? `${monthMatch[2]}-${String(MONTHS[monthMatch[1]]).padStart(2, '0')}`
    : null;
  const health = /salud:\s*fonasa/.test(folded) ? 'Fonasa' : (/salud:\s*\S/.test(folded) ? 'Isapre' : null);

  const result = {
    period,
    netPay: grab(/liquido a (?:recibir|pagar)\s*:?\s*\$?\s*([\d.]+)/),
    contractBase: grab(/sueldo base:\s*\$?\s*([\d.]+)/),
    taxableBase: grab(/base tributable:?\s*\$?\s*([\d.]+)/),
    totalEarnings: grab(/total haberes\s*\$?\s*([\d.]+)/),
    totalDeductions: grab(/total descuentos\s*\$?\s*([\d.]+)/),
    healthSystem: health,
    sectionTotals,
    items,
  };
  result.warnings = validate(result);
  return result;
}

export function validate(p) {
  const warnings = [];
  for (const [section, total] of Object.entries(p.sectionTotals || {})) {
    const sum = p.items.filter((i) => i.section === section).reduce((a, i) => a + i.amount, 0);
    if (sum !== total) {
      warnings.push(`${SECTION_LABELS[section]}: los ítems suman $${sum.toLocaleString('es-CL')} pero el total dice $${total.toLocaleString('es-CL')}.`);
    }
  }
  if (!p.netPay) warnings.push('No se encontró el líquido a pagar.');
  if (!p.period) warnings.push('No se encontró el mes de la liquidación.');
  return warnings;
}

export function summarize(p) {
  const by = (kind) => p.items.filter((i) => i.kind === kind && !i.deleted);
  const sum = (kind) => by(kind).reduce((a, i) => a + Number(i.amount || 0), 0);
  const inSection = (s) => p.items.filter((i) => i.section === s && !i.deleted).reduce((a, i) => a + Number(i.amount || 0), 0);

  const s = {
    baseSalary: sum('baseSalary'),
    gratification: sum('gratification'),
    overtime: sum('overtime'),
    bonuses: sum('bonus'),
    otherTaxable: sum('otherTaxable'),
    allowances: sum('allowance'),
    reimbursementsIn: sum('reimbursement'),
    otherNonTaxable: sum('otherNonTaxable'),
    afp: sum('afp'),
    health: sum('health'),
    unemployment: sum('unemployment'),
    incomeTax: sum('incomeTax'),
    otherLegal: sum('otherLegal'),
    advance: sum('advance'),
    payrollLoans: by('payrollLoan').map((i) => {
      const m = i.label.match(/(\d+)\s*\/\s*(\d+)/);
      return {
        label: i.label,
        amount: i.amount,
        installment: m ? Number(m[1]) : null,
        totalInstallments: m ? Number(m[2]) : null,
      };
    }),
    reimbursementsOut: sum('reimbursementOffset'),
    otherDeductions: sum('otherDeduction'),
    taxableTotal: inSection('taxable'),
    legalTotal: inSection('legal'),
    netPay: Number(p.netPay || 0),
  };
  const netReimbursement = Math.max(0, s.reimbursementsIn - s.reimbursementsOut);
  s.realIncome = s.netPay + s.advance - netReimbursement;
  const legalRate = s.taxableTotal ? s.legalTotal / s.taxableTotal : 0;
  s.bonusNet = Math.round(s.bonuses * (1 - legalRate));
  s.recurringIncome = s.realIncome - s.bonusNet;
  return s;
}
