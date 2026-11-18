// Banco de Chile account statement ("cartola") parser. Pure: takes the words pdf.js extracted
// from each page ({ text, x, y } with y growing downwards) and returns the movements.

const AMOUNT = /^\d{1,3}(?:\.\d{3})*$/;
const pesos = (s) => Number(String(s).replace(/\./g, ''));

function rowsOf(words, tolerance = 2.5) {
  const rows = [];
  for (const w of [...words].filter((x) => String(x.text).trim()).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - w.y) <= tolerance);
    if (row) row.words.push(w); else rows.push({ y: w.y, words: [w] });
  }
  for (const r of rows) r.words.sort((a, b) => a.x - b.x);
  return rows;
}

const textOf = (w) => String(w.text).trim();
const afterLabel = (row, label) => {
  const i = row.words.findIndex((w) => textOf(w).toUpperCase() === label);
  return i >= 0 && row.words[i + 1] ? textOf(row.words[i + 1]).replace(/^:\s*/, '') : null;
};
const dmy = (s) => {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/**
 * pages: Array<Array<{ text, x, y }>>
 * Returns { account, accountType, from, to, movements: [{ date, description, branch, amount, direction }], warnings }.
 * Throws when the file does not look like a cartola.
 */
export function parseCartola(pages) {
  let account = null;
  let accountType = null;
  let from = null;
  let to = null;
  let columns = null; // x where the deposits and balance columns start
  const movements = [];
  let summary = null;

  for (const words of pages) {
    const rows = rowsOf(words);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const line = row.words.map(textOf).join(' ').toUpperCase();
      if (!accountType && /CUENTA (CORRIENTE|VISTA)/.test(line)) {
        accountType = /VISTA/.test(line) ? 'Cuenta Vista' : 'Cuenta Corriente';
      }
      const acc = afterLabel(row, 'N° DE CUENTA');
      if (acc && !account) account = (acc.replace(/\D/g, '').slice(-4)) || null;
      const desde = afterLabel(row, 'DESDE');
      if (desde && !from) from = dmy(desde);
      const hasta = afterLabel(row, 'HASTA');
      if (hasta && !to) to = dmy(hasta);

      if (/MONTO DEPOSITOS/.test(line) && /SALDO/.test(line)) {
        const dep = row.words.find((w) => /MONTO DEPOSITOS/i.test(textOf(w)));
        const bal = row.words.find((w) => /^SALDO$/i.test(textOf(w)));
        columns = { deposits: dep.x - 15, balance: bal.x - 15 };
        continue;
      }
      if (/OTROS CARGOS/.test(line) && /IMPUESTOS/.test(line) && rows[i + 1]) {
        const heads = row.words.map((w) => ({ label: textOf(w).toUpperCase(), x: w.x }));
        summary = {};
        for (const v of rows[i + 1].words.filter((w) => AMOUNT.test(textOf(w)))) {
          const nearest = heads.reduce((best, h) => (Math.abs(h.x - v.x) < Math.abs(best.x - v.x) ? h : best));
          summary[nearest.label] = pesos(textOf(v));
        }
        continue;
      }

      const first = row.words[0];
      if (!columns || !first || first.x > 50 || !/^\d{2}\/\d{2}$/.test(textOf(first))) continue;
      const detail = row.words.filter((w) => w.x > 50 && w.x < 220).map(textOf).join(' ');
      if (/^SALDO (INICIAL|FINAL)/i.test(detail)) continue;
      const branch = row.words.filter((w) => w.x >= 220 && w.x < 290 && !AMOUNT.test(textOf(w))).map(textOf).join(' ');
      const amounts = row.words.filter((w) => w.x >= 290 && AMOUNT.test(textOf(w)));
      const charge = amounts.find((w) => w.x < columns.deposits);
      const credit = amounts.find((w) => w.x >= columns.deposits && w.x < columns.balance);
      const money = charge || credit;
      if (!money) continue;
      movements.push({
        day: textOf(first), description: detail, branch, amount: pesos(textOf(money)), direction: charge ? 'out' : 'in',
      });
    }
  }

  if (!columns || !from || !to || !account) {
    throw new Error('El archivo no parece una cartola del Banco de Chile.');
  }

  const [fromYear, fromMonth] = from.split('-').map(Number);
  const toYear = Number(to.slice(0, 4));
  const dated = movements.map(({ day, ...m }) => {
    const [d, mo] = day.split('/').map(Number);
    const year = mo < fromMonth ? toYear : fromYear;
    return { date: `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ...m };
  });

  const warnings = [];
  if (summary) {
    const expected = ['CHEQUES', 'OTROS CARGOS', 'GIROS CAJERO AUTOMATICO', 'IMPUESTOS'].reduce((a, k) => a + (summary[k] || 0), 0);
    const got = dated.filter((m) => m.direction === 'out').reduce((a, m) => a + m.amount, 0);
    if (expected !== got) {
      warnings.push(`Los cargos leídos suman $${got.toLocaleString('es-CL')} pero la cartola informa $${expected.toLocaleString('es-CL')}. Revisa los movimientos.`);
    }
  }
  return { account, accountType: accountType || 'Cuenta', from, to, movements: dated, warnings };
}
