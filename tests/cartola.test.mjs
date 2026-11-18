import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCartola } from '../js/cartola.js';

// Synthetic statement laid out like Banco de Chile's PDF (595pt wide): x/y positions as pdf.js reports them.
const header = (type, account, from, to, page, pages) => [
  { text: 'Estado de Cuenta', x: 494, y: 87 },
  { text: `CUENTA ${type}`, x: 472, y: 109 },
  { text: 'N° DE CUENTA', x: 309, y: 218 }, { text: `: XXXXXXXX${account}`, x: 374, y: 218 },
  { text: 'DESDE', x: 309, y: 247 }, { text: `: ${from}`, x: 374, y: 247 },
  { text: 'HASTA', x: 454, y: 247 }, { text: `: ${to}`, x: 513, y: 247 },
  { text: 'N° DE PAGINA', x: 454, y: 232 }, { text: `${page} DE ${pages}`, x: 526, y: 232 },
  { text: 'FECHA', x: 23, y: 261 }, { text: 'DETALLE DE TRANSACCION', x: 80, y: 261 }, { text: 'SUCURSAL', x: 237, y: 261 },
  { text: 'N° DOCTO', x: 298, y: 261 }, { text: 'MONTO CHEQUES', x: 344, y: 261 }, { text: 'MONTO DEPOSITOS', x: 419, y: 261 },
  { text: 'SALDO', x: 534, y: 261 },
];
let y = 286;
const row = (date, detail, amount, side, balance) => {
  y += 9;
  const words = [{ text: date, x: 28, y }, { text: detail, x: 60, y }, { text: 'INTERNET', x: 227, y }];
  if (amount) words.push({ text: amount, x: side === 'out' ? 393 : 466, y });
  if (balance) words.push({ text: balance, x: 555, y });
  return words;
};

function statement() {
  y = 286;
  const page1 = [
    ...header('CORRIENTE', '1234', '30/11/2026', '30/12/2026', 1, 2),
    { text: '30/11', x: 28, y: 286 }, { text: 'SALDO INICIAL', x: 60, y: 286 }, { text: '1.000', x: 560, y: 286 },
    ...row('01/12', 'PAGO:MERPAGO*MINISUPER', '4.930', 'out'),
    ...row('01/12', 'TRASPASO A:Tarjeta Ejemplo', '40.000', 'out'),
    ...row('01/12', 'TRASPASO DE:EMPRESA EJEMPLO SPA', '900.000', 'in', '856.070'),
    ...row('02/12', 'PAGO EN SERVIPAG.COM*', '72.768', 'out'),
  ];
  y = 286;
  const page2 = [
    ...header('CORRIENTE', '1234', '30/11/2026', '30/12/2026', 2, 2),
    ...row('15/12', 'TRASPASO A CUENTA:000099990000', '20.000', 'out'),
    ...row('29/12', 'COMISION ADMIN. MENSUAL PLAN CUENT', '3.269', 'out', '760.033'),
    { text: '30/12', x: 28, y: 400 }, { text: 'SALDO FINAL', x: 60, y: 400 }, { text: '760.033', x: 560, y: 400 },
    { text: 'DEPOSITOS', x: 43, y: 655 }, { text: 'CHEQUES', x: 133, y: 655 }, { text: 'OTROS ABONOS', x: 213, y: 655 },
    { text: 'OTROS CARGOS', x: 300, y: 655 }, { text: 'GIROS CAJERO AUTOMATICO', x: 380, y: 655 }, { text: 'IMPUESTOS', x: 513, y: 655 },
    { text: '0', x: 98, y: 672 }, { text: '0', x: 188, y: 672 }, { text: '900.000', x: 243, y: 672 },
    { text: '140.967', x: 331, y: 672 }, { text: '0', x: 478, y: 672 }, { text: '0', x: 563, y: 672 },
  ];
  return [page1, page2];
}

test('reads account, period and every movement across pages', () => {
  const c = parseCartola(statement());
  assert.equal(c.account, '1234');
  assert.equal(c.accountType, 'Cuenta Corriente');
  assert.equal(c.from, '2026-11-30');
  assert.equal(c.to, '2026-12-30');
  assert.deepEqual(c.movements.map((m) => [m.date, m.description, m.amount, m.direction]), [
    ['2026-12-01', 'PAGO:MERPAGO*MINISUPER', 4930, 'out'],
    ['2026-12-01', 'TRASPASO A:Tarjeta Ejemplo', 40000, 'out'],
    ['2026-12-01', 'TRASPASO DE:EMPRESA EJEMPLO SPA', 900000, 'in'],
    ['2026-12-02', 'PAGO EN SERVIPAG.COM*', 72768, 'out'],
    ['2026-12-15', 'TRASPASO A CUENTA:000099990000', 20000, 'out'],
    ['2026-12-29', 'COMISION ADMIN. MENSUAL PLAN CUENT', 3269, 'out'],
  ]);
  assert.deepEqual(c.warnings, []);
});

test('assigns the next year to dates after a December-January boundary', () => {
  y = 286;
  const page = [...header('VISTA', '5678', '30/12/2026', '30/01/2027', 1, 1),
    ...row('31/12', 'PAGO:UNO', '1.000', 'out'), ...row('02/01', 'PAGO:DOS', '2.000', 'out')];
  const c = parseCartola([page]);
  assert.equal(c.accountType, 'Cuenta Vista');
  assert.deepEqual(c.movements.map((m) => m.date), ['2026-12-31', '2027-01-02']);
});

test('warns when the charges do not add up to the statement totals', () => {
  const pages = statement();
  const last = pages[1];
  last.find((w) => w.text === '140.967').text = '150.000';
  const c = parseCartola(pages);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /cargos/i);
});

test('rejects files that are not a cartola', () => {
  assert.throws(() => parseCartola([[{ text: 'Liquidación de Sueldo', x: 10, y: 10 }]]), /cartola/i);
});
