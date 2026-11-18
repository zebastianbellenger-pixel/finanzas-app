import {
  loadLocal, saveLocal, newId, live, mergeStates, normalizeState,
} from './store.js';
import {
  computePlan, antAlerts, debtPayoff, shoppingList, isDebtActive, pickPayslip,
} from './budget.js';
import { todayISO, cycleFor, mondayOf, addDays } from './cycle.js';
import {
  parsePayslipText, summarize, wordsToText, validate, classify,
  KIND_LABELS, SECTION_LABELS, SECTION_KINDS,
} from './payslip.js';
import {
  CATALOG, MEALS, HABITS, SEASONAL_FRUIT, withPrices,
} from './food.js';
import { loadSyncConfig, saveSyncConfig, syncNow } from './sync.js';
import {
  loadGmailConfig, saveGmailConfig, preloadGis, requestGmailToken, revokeGmailToken, fetchBankMovements, CLIENT_ID_PATTERN,
} from './gmail.js';
import { planImport } from './bankmail.js';
import { esc, barChart, lineChart, hbars } from './charts.js';

// ---------- constants & helpers ----------

const CATEGORIES = [
  { id: 'comida', label: 'Comida', icon: '🍽️' },
  { id: 'supermercado', label: 'Súper', icon: '🛒' },
  { id: 'delivery', label: 'Delivery', icon: '🛵' },
  { id: 'transporte', label: 'Transporte', icon: '🚌' },
  { id: 'combustible', label: 'Petróleo', icon: '⛽' },
  { id: 'ocio', label: 'Ocio', icon: '🎮' },
  { id: 'salud', label: 'Salud', icon: '💊' },
  { id: 'otros', label: 'Otros', icon: '📦' },
];
const catLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label ?? id;
const catIcon = (id) => CATEGORIES.find((c) => c.id === id)?.icon ?? '•';

const DEBT_TYPES = { card: 'Tarjeta de crédito', loan: 'Crédito / préstamo', installments: 'Compra en cuotas' };
const STATUS = {
  green: { label: 'Vas bien', icon: '✓' },
  yellow: { label: 'Cerca del límite', icon: '!' },
  red: { label: 'Te pasaste', icon: '✕' },
};
const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

const nf = new Intl.NumberFormat('es-CL');
const money = (n) => `${n < 0 ? '−' : ''}$${nf.format(Math.abs(Math.round(Number(n) || 0)))}`;
const digits = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
const decimal = (v) => Number(String(v ?? '').replace(',', '.').replace(/[^\d.]/g, '')) || 0;
const optionalNumber = (v) => (String(v ?? '').trim() === '' ? null : digits(v));
const fmtDate = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-CL', opts);
const periodLabel = (p) => {
  if (!p) return 'Sin mes';
  const [y, m] = p.split('-').map(Number);
  return `${MONTH_NAMES[m - 1][0].toUpperCase()}${MONTH_NAMES[m - 1].slice(1)} ${y}`;
};
const monthsFromNow = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
};
const sum = (list, fn = (x) => x.amount) => list.reduce((a, x) => a + Number(fn(x) || 0), 0);

function lsGet(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

// ---------- state ----------

let state = loadLocal();
const ui = {
  tab: lsGet('finanzas.tab', 'home'),
  draft: null,
  parsing: '',
  syncText: '',
  syncError: false,
  gmail: { rows: null, loading: '', from: null },
};

function touch(rec) {
  rec.updatedAt = Date.now();
  return rec;
}
function upsert(collection, rec) {
  touch(rec);
  const list = state[collection];
  const i = list.findIndex((x) => x.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
}
/** Records a payment and lowers the debt's balance or remaining installments. */
function payDebt(debt, amount, date, ref) {
  upsert('debtPayments', { id: newId('dp'), debtId: debt.id, date, amount, ...(ref ? { ref } : {}) });
  const next = { ...debt };
  if (debt.type === 'installments') {
    if (debt.installmentsLeft != null) next.installmentsLeft = Math.max(0, debt.installmentsLeft - 1);
  } else if (debt.balance != null) {
    next.balance = Math.max(0, debt.balance - amount);
  }
  upsert('debts', next);
  return next;
}
function removeRecord(collection, id) {
  const rec = state[collection].find((x) => x.id === id);
  if (rec) { rec.deleted = true; touch(rec); }
}
function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch, updatedAt: Date.now() };
}
function persist({ silent = false } = {}) {
  if (!saveLocal(state)) toast('No se pudo guardar en este navegador. Exporta un respaldo.');
  scheduleSync();
  if (!silent) render();
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------- sync ----------

let syncTimer;
let syncing = false;
let syncAgain = false;
function scheduleSync() {
  if (!loadSyncConfig()) return;
  if (syncing) { syncAgain = true; return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 1500);
}
async function runSync(manual = false) {
  const config = loadSyncConfig();
  if (!config) {
    if (manual) { ui.tab = 'more'; render(); toast('Configura la sincronización con GitHub en "Más".'); }
    updateSyncPill();
    return;
  }
  if (syncing) return;
  syncing = true;
  ui.syncText = 'Sincronizando…';
  ui.syncError = false;
  updateSyncPill();
  try {
    const merged = await syncNow(config, state);
    // Edits made while the request was in flight live only in `state`: merge, never replace.
    state = mergeStates(merged, state);
    saveLocal(state);
    ui.syncText = `Sincronizado ${new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}`;
    if (!isTyping()) render();
  } catch (err) {
    ui.syncText = 'Error al sincronizar';
    ui.syncError = true;
    if (manual) toast(err.message);
    console.warn(err);
  } finally {
    syncing = false;
    updateSyncPill();
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}
function isTyping() {
  const el = document.activeElement;
  return el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}
function updateSyncPill() {
  const pill = document.getElementById('sync-pill');
  pill.textContent = loadSyncConfig() ? (ui.syncText || 'GitHub conectado') : 'Solo en este equipo';
  pill.classList.toggle('error', ui.syncError);
}

// ---------- views ----------

function render() {
  const views = { home: viewHome, expenses: viewExpenses, accounts: viewAccounts, payslip: viewPayslip, food: viewFood, more: viewMore };
  if (!views[ui.tab]) ui.tab = 'home';
  document.getElementById('view').innerHTML = views[ui.tab]();
  document.querySelectorAll('.tabs button').forEach((b) => {
    const active = b.dataset.tab === ui.tab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  updateSyncPill();
}

function incomeBanner(plan) {
  if (plan.income > 0) return '';
  return `<div class="alert warning">Para calcular tu presupuesto necesito tu sueldo.
    <div class="actions"><button class="btn-primary btn-small" data-action="tab" data-tab="payslip">Cargar liquidación</button>
    <button class="btn-small" data-action="tab" data-tab="more">Ingresar sueldo a mano</button></div></div>`;
}

function viewHome() {
  const today = todayISO();
  const plan = computePlan(state, today);
  const st = STATUS[plan.status];
  const canSpend = Math.max(0, plan.remainingToday);
  const overBy = plan.remainingToday < 0 ? -plan.remainingToday : 0;
  const todays = live(state.expenses).filter((e) => e.date === today).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const alerts = antAlerts(state.expenses, today, state.settings.antThreshold);
  const prev = previousCycleLeftover(plan);

  return `
  ${incomeBanner(plan)}
  <section class="kpis" aria-label="Resumen de hoy">
    <article class="kpi kpi-main status-${plan.status}">
      <p class="kpi-label">Puedes gastar hoy</p>
      <p class="kpi-value">${money(canSpend)}</p>
      <span class="pill ${plan.status}"><span aria-hidden="true">${st.icon}</span>${st.label}</span>
      <p class="kpi-sub">${overBy ? `Te pasaste ${money(overBy)}; mañana tu monto diario baja.` : `Gastado hoy ${money(plan.spentToday)} de ${money(plan.dailyAllowance)}`}</p>
    </article>
    <article class="kpi">
      <p class="kpi-label">Ahorro del mes</p>
      <p class="kpi-value">${money(plan.savedInCycle)}</p>
      <p class="kpi-sub">Meta fondo de emergencia: ${money(plan.emergency)}</p>
      <p class="kpi-sub">Tarjetas pagadas: ${money(plan.cardPaidInCycle)} de ${money(plan.cardPayments)}</p>
    </article>
    <article class="kpi">
      <p class="kpi-label">Presupuesto de comida hoy</p>
      <p class="kpi-value">${money(Math.max(0, plan.foodToday))}</p>
      <p class="kpi-sub">Semana: ${money(plan.foodWeekBudget)} para comida</p>
    </article>
  </section>

  <form class="card" data-form="quick" autocomplete="off">
    <h2>Registrar gasto</h2>
    <button type="submit" hidden disabled aria-hidden="true"></button>
    <label for="q-amount">Monto</label>
    <input id="q-amount" class="amount-input" name="amount" inputmode="numeric" placeholder="$0" required>
    <details><summary>Agregar nota (opcional)</summary><input name="note" placeholder="Ej: café, almuerzo, Uber"></details>
    <p class="muted small">Escribe el monto y toca la categoría para guardarlo.</p>
    <div class="cat-grid">
      ${CATEGORIES.map((c) => `<button type="submit" class="cat-btn" name="category" value="${c.id}"><span aria-hidden="true">${c.icon}</span>${c.label}</button>`).join('')}
    </div>
  </form>

  ${alerts.length ? `<section class="card"><h2>Gastos hormiga</h2>${alerts.map(alertHtml).join('')}</section>` : ''}

  <section class="card">
    <div class="split"><h2>Hoy</h2><span class="amount">${money(sum(todays))}</span></div>
    ${todays.length ? `<ul class="list">${todays.map(expenseItem).join('')}</ul>` : '<p class="muted">Aún no registras gastos hoy.</p>'}
  </section>

  ${cycleCard(plan)}
  ${prev ? `<div class="alert good">Te sobraron ${money(prev.amount)} del ciclo anterior. Si lo pasas a ahorro, avanzas hacia el 30% real.
    <div class="actions"><button class="btn-primary btn-small" data-action="save-leftover" data-amount="${esc(prev.amount)}" data-cycle="${esc(prev.start)}">Pasar a ahorro</button></div></div>` : ''}
  ${savingsCard(plan)}`;
}

function alertHtml(a) {
  if (a.kind === 'small') return `<div class="alert warning">🐜 ${a.count} compras pequeñas en 7 días suman ${money(a.total)}. Al mes serían unos ${money(a.monthly)}.</div>`;
  if (a.kind === 'delivery') return `<div class="alert warning">🛵 ${a.count} pedidos de delivery esta semana (${money(a.total)}). Cocinar eso en casa cuesta cerca de ${money(a.count * state.settings.homeMealCost)}.</div>`;
  return `<div class="alert warning">🔁 "${esc(a.note)}" se repite ${a.count} veces esta semana (${money(a.total)}).</div>`;
}

function expenseItem(e) {
  return `<li><div><div>${esc(catIcon(e.category))} ${esc(catLabel(e.category))}${e.note ? ` · <span class="muted">${esc(e.note)}</span>` : ''}</div>
    <div class="meta">${fmtDate(e.date)}</div></div>
    <div class="actions" style="margin:0"><span class="amount">${money(e.amount)}</span>
    <button class="btn-link btn-danger" data-action="del-expense" data-id="${esc(e.id)}" aria-label="Eliminar gasto">✕</button></div></li>`;
}

function cycleCard(plan) {
  const c = plan.cycle;
  const used = plan.spendable > 0 ? Math.min(100, ((plan.spentBefore + plan.spentToday) / plan.spendable) * 100) : 100;
  return `<section class="card">
    <h2>Tu ciclo de pago</h2>
    <p class="muted small">Del ${fmtDate(c.start)} al ${fmtDate(c.end)} · próximo sueldo ${fmtDate(c.nextPayday)} · anticipo el ${fmtDate(c.advanceDate, { day: 'numeric', month: 'short' })}</p>
    <div class="split"><span>Para vivir este ciclo</span><span class="amount">${money(plan.spendable)}</span></div>
    <div class="progress ${used >= 100 ? 'over' : ''}" role="progressbar" aria-valuenow="${Math.round(used)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${used}%"></div></div>
    <div class="split small"><span class="muted">Gastado ${money(plan.spentBefore + plan.spentToday)}</span><span class="muted">Quedan ${plan.daysLeft} días</span></div>
    ${plan.envelopeStatus.map((env) => `
      <div class="split small" style="margin-top:10px"><span>${esc(env.name)}</span><span class="amount">${money(env.spent)} / ${money(env.budget)}</span></div>
      <div class="progress ${env.spent > env.budget ? 'over' : ''}"><div style="width:${Math.min(100, (env.spent / Math.max(1, env.budget)) * 100)}%"></div></div>`).join('')}
    <details><summary>¿Cómo se calcula?</summary>
      <table>
        <tr><td>Ingreso del ciclo (líquido + anticipo, sin bonos)</td><td class="num">${money(plan.income)}</td></tr>
        <tr><td>− 30% (tarjetas ${money(plan.cardPayments)} + fondo de emergencia ${money(plan.emergency)})</td><td class="num">${money(-Math.max(plan.target, plan.cardPayments))}</td></tr>
        <tr><td>− Gastos fijos, sobres y cuotas</td><td class="num">${money(-plan.fixedTotal)}</td></tr>
        <tr><th>Para vivir</th><th class="num">${money(plan.spendable)}</th></tr>
        <tr><td>÷ ${plan.days} días = monto base diario</td><td class="num">${money(plan.baselineDaily)}</td></tr>
      </table>
      <p class="small muted">Cada día se recalcula: (para vivir − lo ya gastado) ÷ días que faltan. ${plan.payslipPeriod ? `Liquidación usada: ${periodLabel(plan.payslipPeriod)}${plan.payslipExact ? '' : ' (aún no cargas la de este mes)'}.` : ''}</p>
      ${plan.bonusNet ? `<p class="small">Bono de este mes: cerca de ${money(plan.bonusNet)} líquido. Va directo a ahorro o a pagar tarjetas, no al gasto diario.</p>` : ''}
    </details>
  </section>`;
}

function previousCycleLeftover(plan) {
  const prevEnd = addDays(plan.cycle.start, -1);
  const prevCycle = cycleFor(prevEnd, state.settings.advanceDay);
  const hadActivity = live(state.expenses).some((e) => e.date >= prevCycle.start && e.date <= prevCycle.end);
  if (!hadActivity) return null;
  const already = live(state.savings).some((s) => s.kind === 'leftover' && s.cycle === prevCycle.start);
  if (already) return null;
  const p = computePlan(state, prevEnd);
  const leftover = p.available - p.spentToday;
  return leftover > 0 ? { amount: leftover, start: prevCycle.start } : null;
}

function savingsByCycle() {
  const map = new Map();
  for (const s of live(state.savings)) {
    const key = cycleFor(s.date, state.settings.advanceDay).start;
    map.set(key, (map.get(key) || 0) + Number(s.amount || 0));
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function savingsCard(plan) {
  const year = todayISO().slice(0, 4);
  const yearSaved = sum(live(state.savings).filter((s) => s.date.startsWith(year)));
  const yearCards = sum(live(state.debtPayments).filter((p) => p.date.startsWith(year)
    && state.debts.some((d) => d.id === p.debtId && d.type === 'card')));
  const series = savingsByCycle().slice(-12).map(([start, value]) => {
    const c = cycleFor(start, state.settings.advanceDay);
    return { label: MONTH_NAMES[Number(c.salaryPeriod.slice(5)) - 1].slice(0, 3), value, tip: `Ciclo ${periodLabel(c.salaryPeriod)}\nAhorro: ${money(value)}` };
  });
  const pending = Math.max(0, plan.emergency - plan.savedInCycle);
  return `<section class="card">
    <h2>Ahorro</h2>
    <div class="row">
      <div><p class="muted small">Ahorro del año ${year}</p><p class="amount" style="font-size:1.3rem">${money(yearSaved)}</p></div>
      <div><p class="muted small">Pagado en tarjetas ${year}</p><p class="amount" style="font-size:1.3rem">${money(yearCards)}</p></div>
    </div>
    ${barChart(series, { target: plan.emergency || undefined, targetLabel: 'Meta', ariaLabel: 'Ahorro por ciclo' })}
    <details><summary>Ver tabla</summary><table><tr><th>Ciclo</th><th class="num">Ahorro</th></tr>
      ${series.map((s) => `<tr><td>${esc(s.tip.split('\n')[0])}</td><td class="num">${money(s.value)}</td></tr>`).join('')}</table></details>
    <form data-form="saving" class="inline-form" autocomplete="off">
      <input name="amount" inputmode="numeric" value="${esc(pending || '')}" placeholder="Monto" aria-label="Monto a ahorrar">
      <button type="submit" class="btn-primary btn-small">Registrar ahorro</button>
    </form>
    <p class="small muted">Registra cuando transfieras a tu cuenta de ahorro. Así el número es real, no una promesa.</p>
  </section>`;
}

function viewExpenses() {
  const today = todayISO();
  const plan = computePlan(state, today);
  const c = plan.cycle;
  const list = live(state.expenses).filter((e) => e.date >= c.start && e.date <= c.end)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  const byCat = CATEGORIES.map((cat) => ({ label: cat.label, value: sum(list.filter((e) => e.category === cat.id)) }))
    .filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const days = [...new Set(list.map((e) => e.date))];
  const note = live(state.cycleNotes).find((n) => n.id === c.start);

  return `
  <form class="card" data-form="expense" autocomplete="off">
    <h2>Agregar gasto</h2>
    <div class="row">
      <div><label for="e-amount">Monto</label><input id="e-amount" name="amount" inputmode="numeric" required placeholder="$0"></div>
      <div><label for="e-date">Fecha</label><input id="e-date" type="date" name="date" value="${today}" min="${c.start}" max="${today}" required></div>
    </div>
    <div class="row">
      <div><label for="e-cat">Categoría</label><select id="e-cat" name="category">${CATEGORIES.map((x) => `<option value="${x.id}">${x.label}</option>`).join('')}</select></div>
      <div><label for="e-note">Nota</label><input id="e-note" name="note" placeholder="Opcional"></div>
    </div>
    <button class="btn-primary" type="submit">Guardar</button>
  </form>

  ${gmailCard(c.start)}

  <section class="card">
    <h2>Por categoría en este ciclo</h2>
    ${byCat.length ? hbars(byCat, money) : '<p class="muted">Sin gastos todavía.</p>'}
  </section>

  <section class="card">
    <div class="split"><h2>Gastos del ciclo</h2><span class="amount">${money(sum(list))}</span></div>
    ${days.length ? days.map((d) => `<h3 class="section-title">${fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
      <ul class="list">${list.filter((e) => e.date === d).map(expenseItem).join('')}</ul>`).join('') : '<p class="muted">Aún no hay gastos en este ciclo.</p>'}
  </section>

  <form class="card" data-form="opening" autocomplete="off">
    <h2>¿Empezaste a usar la app a mitad de ciclo?</h2>
    <p class="small muted">Si antes de registrar ya habías gastado plata de este ciclo (desde el ${fmtDate(c.start)}), anótalo aquí para que el monto diario sea real.</p>
    <div class="inline-form"><input name="amount" inputmode="numeric" value="${esc(note?.openingSpent || '')}" placeholder="$0" aria-label="Gastado antes de usar la app">
    <button class="btn-small" type="submit">Guardar</button></div>
  </form>`;
}

function gmailCard(cycleStart) {
  const config = loadGmailConfig();
  if (!config) {
    return `
  <section class="card">
    <h2>Importar cobros desde Gmail</h2>
    <p class="small muted">Lee los avisos de compra, transferencias y pagos de Banco de Chile y BancoEstado, y te los muestra para que confirmes antes de guardar. Solo pide permiso de <strong>lectura</strong>; los correos se leen en este navegador y no se envían a ningún otro lado.</p>
    <details>
      <summary>Cómo obtener el ID de cliente de Google (una sola vez, ~10 min)</summary>
      <ol class="small">
        <li>Entra a <strong>console.cloud.google.com</strong> y crea un proyecto (por ejemplo "Mis Finanzas").</li>
        <li>En <em>APIs y servicios → Biblioteca</em>, busca <strong>Gmail API</strong> y habilítala.</li>
        <li>En <em>Google Auth Platform</em> (pantalla de consentimiento): tipo <strong>Externo</strong>, déjala en <strong>Prueba</strong> y agrega tu Gmail como <strong>usuario de prueba</strong>.</li>
        <li>En <em>Clientes → Crear cliente</em>: tipo <strong>Aplicación web</strong>; en <em>Orígenes autorizados de JavaScript</em> agrega <code>${esc(location.origin)}</code>.</li>
        <li>Copia el <strong>ID de cliente</strong> y pégalo abajo. Al dar permiso, Google avisará que la app no está verificada: es tu propia app, elige <em>Continuar</em>.</li>
      </ol>
    </details>
    <form data-form="gmail-setup" autocomplete="off">
      <label for="g-client">ID de cliente de Google</label>
      <div class="inline-form"><input id="g-client" name="clientId" required placeholder="123…apps.googleusercontent.com">
      <button class="btn-small btn-primary" type="submit">Guardar</button></div>
    </form>
  </section>`;
  }
  preloadGis().catch(() => {});
  const g = ui.gmail;
  if (g.rows) {
    const debts = live(state.debts).filter(isDebtActive);
    const options = (row) => {
      const current = row.action.type === 'expense' ? `cat:${row.action.category}`
        : row.action.type === 'debt' ? `debt:${row.action.debtId}` : 'skip';
      const opt = (value, label) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
      return opt('skip', 'No registrar')
        + `<optgroup label="Gasto">${CATEGORIES.map((x) => opt(`cat:${x.id}`, x.label)).join('')}</optgroup>`
        + (debts.length ? `<optgroup label="Pago de deuda">${debts.map((d) => opt(`debt:${d.id}`, d.name)).join('')}</optgroup>` : '');
    };
    return `
  <form class="card" data-form="gmail-import" autocomplete="off">
    <div class="split"><h2>Cobros encontrados</h2><span class="amount">${g.rows.length}</span></div>
    <p class="small muted">Revisa cada uno y elige cómo registrarlo. Lo que marques "No registrar" no se volverá a ofrecer.</p>
    <ul class="list">${g.rows.map((r, i) => `
      <li class="import-row">
        <div><strong>${esc(r.description)}</strong>
          <div class="small muted">${fmtDate(r.date)} · ${esc(r.bank)}${r.reason ? ` · ${esc(r.reason)}` : ''}</div></div>
        <div class="import-side"><span class="amount">${money(r.amount)}</span>
          <select name="a${i}" aria-label="Registrar ${esc(r.description)} como">${options(r)}</select></div>
      </li>`).join('')}</ul>
    <div class="actions"><button class="btn-primary" type="submit">Guardar</button>
    <button type="button" data-action="gmail-cancel">Cancelar</button></div>
  </form>`;
  }
  return `
  <form class="card" data-form="gmail-fetch" autocomplete="off">
    <h2>Importar cobros desde Gmail</h2>
    <div class="inline-form"><label for="g-from" class="small">Desde</label>
      <input id="g-from" type="date" name="from" value="${esc(g.from || cycleStart)}" max="${todayISO()}" required>
      <button class="btn-small btn-primary" type="submit"${g.loading ? ' disabled' : ''}>Buscar cobros</button></div>
    <p class="small muted" id="gmail-status" aria-live="polite">${esc(g.loading || 'Banco de Chile y BancoEstado. Te pedirá permiso de lectura de Gmail (dura 1 hora).')}</p>
    <button type="button" class="btn-link small" data-action="gmail-forget">Desconectar Gmail de este equipo</button>
  </form>`;
}

function setGmailStatus(text) {
  ui.gmail.loading = text;
  const el = document.getElementById('gmail-status');
  if (el) el.textContent = text;
}

function viewAccounts() {
  const plan = computePlan(state, todayISO());
  const fixed = live(state.fixedExpenses).sort((a, b) => (a.dueDay || 99) - (b.dueDay || 99));
  const debts = live(state.debts).sort((a, b) => {
    const ra = debtPayoff(a).remaining ?? Infinity;
    const rb = debtPayoff(b).remaining ?? Infinity;
    return ra - rb;
  });
  const active = debts.filter(isDebtActive);
  const knownDebt = sum(active, (d) => debtPayoff(d).remaining);
  const unknown = active.filter((d) => debtPayoff(d).remaining == null).length;
  const { payslip } = pickPayslip(state.payslips, plan.salaryPeriod);
  const payrollLoans = payslip ? summarize(payslip).payrollLoans : [];

  return `
  <section class="card">
    <h2>Compromisos del mes</h2>
    <div class="split"><span>Gastos fijos, sobres y cuotas</span><span class="amount">${money(plan.fixedTotal)}</span></div>
    <div class="split"><span>Tarjetas (cuentan para tu 30%)</span><span class="amount">${money(plan.cardPayments)}</span></div>
    <div class="split"><strong>Total mensual</strong><span class="amount">${money(plan.fixedTotal + plan.cardPayments)}</span></div>
    <div class="split" style="margin-top:8px"><span>Deuda total conocida</span><span class="amount">${money(knownDebt)}</span></div>
    ${unknown ? `<p class="small muted">${unknown} deuda(s) sin saldo ingresado. Agrégalo para saber cuándo terminas de pagar.</p>` : ''}
  </section>

  <section class="card">
    <h2>Deudas</h2>
    <p class="small muted">Ordenadas de menor a mayor saldo (método bola de nieve): paga el mínimo en todas y todo lo extra a la primera. Cada deuda que cierras libera su cuota.</p>
    ${debts.length ? debts.map(debtCard).join('') : '<p class="muted">No hay deudas registradas.</p>'}
    ${payrollLoans.length ? `<div class="note" style="margin-top:12px"><strong>Descontado por planilla</strong> (ya viene restado en tu líquido, no lo agregues aquí):
      <ul>${payrollLoans.map((l) => `<li>${esc(l.label)}: ${money(l.amount)}</li>`).join('')}</ul></div>` : ''}
  </section>

  <form class="card" data-form="debt-add" autocomplete="off">
    <h2>Agregar deuda</h2>
    <div class="row">
      <div><label>Nombre</label><input name="name" required placeholder="Ej: CMR Falabella"></div>
      <div><label>Tipo</label><select name="type">${Object.entries(DEBT_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <div><label>Pago mensual</label><input name="payment" inputmode="numeric" required placeholder="$0"></div>
      <div><label>Día de pago</label><input name="dueDay" inputmode="numeric" placeholder="1-31"></div>
    </div>
    <div class="row">
      <div><label>Saldo total (tarjetas y créditos)</label><input name="balance" inputmode="numeric" placeholder="Opcional"></div>
      <div><label>Cuotas que faltan (compras en cuotas)</label><input name="installmentsLeft" inputmode="numeric" placeholder="Opcional"></div>
      <div><label>Interés mensual %</label><input name="rate" inputmode="decimal" placeholder="Opcional"></div>
    </div>
    <button class="btn-primary" type="submit">Agregar</button>
  </form>

  <section class="card">
    <h2>Gastos fijos y sobres</h2>
    <p class="small muted">Un <strong>sobre</strong> es un gasto que pagas de a poco en el mes (como el petróleo): lo que registras en esa categoría sale del sobre y no de tu monto diario, salvo que te pases.</p>
    ${fixed.length ? fixed.map(fixedRow).join('') : '<p class="muted">Sin gastos fijos.</p>'}
  </section>

  <form class="card" data-form="fixed-add" autocomplete="off">
    <h2>Agregar gasto fijo</h2>
    <div class="row">
      <div><label>Nombre</label><input name="name" required placeholder="Ej: Luz, agua, internet"></div>
      <div><label>Monto mensual</label><input name="amount" inputmode="numeric" required placeholder="$0"></div>
    </div>
    <div class="row">
      <div><label>Día de pago</label><input name="dueDay" inputmode="numeric" placeholder="1-31"></div>
      <div><label>Tipo</label><select name="kind"><option value="fixed">Gasto fijo</option><option value="envelope">Sobre mensual</option></select></div>
      <div><label>Categoría del sobre</label><select name="category"><option value="">—</option>${CATEGORIES.map((x) => `<option value="${x.id}">${x.label}</option>`).join('')}</select></div>
    </div>
    <button class="btn-primary" type="submit">Agregar</button>
    <p class="small muted">Servicios básicos: revisa los montos en Servipag y anótalos aquí. Cuando cambien, edítalos.</p>
  </form>`;
}

function debtCard(d) {
  const { months, remaining } = debtPayoff(d);
  const done = !isDebtActive(d);
  let payoff = 'Agrega el saldo para calcular cuándo terminas.';
  if (done) payoff = '¡Pagada! 🎉';
  else if (months === Infinity) payoff = 'Con este pago la deuda no baja: el interés se come la cuota.';
  else if (months != null) payoff = `Terminas en ${months} ${months === 1 ? 'mes' : 'meses'} (${monthsFromNow(months)}).`;
  return `<div class="debt">
    <div class="split"><strong>${esc(d.name)}</strong><span class="badge">${esc(DEBT_TYPES[d.type] ?? d.type)}</span></div>
    <div class="split small"><span>Cuota mensual${d.dueDay ? ` · día ${esc(d.dueDay)}` : ''}</span><span class="amount">${money(d.payment)}</span></div>
    <div class="split small"><span>${d.type === 'installments' ? `Faltan ${esc(d.installmentsLeft ?? '?')} cuotas` : 'Saldo'}</span><span class="amount">${remaining == null ? '—' : money(remaining)}</span></div>
    <p class="small ${done ? '' : 'muted'}">${payoff}</p>
    ${done ? '' : `<form class="inline-form" data-form="debt-pay" data-id="${esc(d.id)}" autocomplete="off">
      <input name="amount" inputmode="numeric" value="${esc(d.payment)}" aria-label="Monto pagado">
      <button type="submit" class="btn-small">Registrar pago</button></form>`}
    <details><summary>Editar</summary>
      <form data-form="debt-edit" data-id="${esc(d.id)}" autocomplete="off">
        <div class="row">
          <div><label>Nombre</label><input name="name" value="${esc(d.name)}"></div>
          <div><label>Pago mensual</label><input name="payment" inputmode="numeric" value="${esc(d.payment ?? '')}"></div>
          <div><label>Día de pago</label><input name="dueDay" inputmode="numeric" value="${esc(d.dueDay ?? '')}"></div>
        </div>
        <div class="row">
          <div><label>Saldo</label><input name="balance" inputmode="numeric" value="${esc(d.balance ?? '')}"></div>
          <div><label>Cuotas que faltan</label><input name="installmentsLeft" inputmode="numeric" value="${esc(d.installmentsLeft ?? '')}"></div>
          <div><label>Interés mensual %</label><input name="rate" inputmode="decimal" value="${esc(d.rate ?? '')}"></div>
        </div>
        <div class="actions"><button type="submit" class="btn-small btn-primary" name="op" value="save">Guardar</button>
        <button type="submit" class="btn-small btn-danger" name="op" value="delete">Eliminar</button></div>
      </form>
    </details>
  </div>`;
}

function fixedRow(f) {
  return `<form class="debt" data-form="fixed-edit" data-id="${esc(f.id)}" autocomplete="off">
    <div class="split"><strong>${esc(f.name)}</strong><span class="badge">${f.kind === 'envelope' ? `Sobre · ${esc(catLabel(f.category))}` : 'Fijo'}</span></div>
    <div class="row" style="margin-top:6px">
      <div><label>Monto</label><input name="amount" inputmode="numeric" value="${esc(f.amount)}"></div>
      <div><label>Día</label><input name="dueDay" inputmode="numeric" value="${esc(f.dueDay ?? '')}"></div>
    </div>
    <div class="actions" style="margin-top:0"><button type="submit" class="btn-small" name="op" value="save">Guardar</button>
    <button type="submit" class="btn-small btn-danger" name="op" value="delete">Eliminar</button></div>
  </form>`;
}

function viewPayslip() {
  const slips = live(state.payslips).filter((p) => p.period).sort((a, b) => a.period.localeCompare(b.period));
  const rows = slips.map((p) => ({ p, s: summarize(p) }));
  const series = rows.map(({ p, s }) => ({
    label: MONTH_NAMES[Number(p.period.slice(5)) - 1].slice(0, 3),
    value: s.realIncome,
    tip: `${periodLabel(p.period)}\nLíquido: ${money(s.netPay)}\nIngreso real: ${money(s.realIncome)}${s.bonuses ? `\nBonos: ${money(s.bonuses)}` : ''}`,
  }));

  return `
  ${ui.draft ? draftForm() : `
  <section class="card">
    <h2>Cargar liquidación</h2>
    <label class="upload">
      <input type="file" accept="application/pdf,image/*" data-change="payslip-file">
      <strong>📄 Subir PDF o foto</strong><br><span class="small muted">Descárgala en PDF desde tu portal Buk. Se lee aquí mismo, en tu equipo: no se envía a ningún servidor.</span>
    </label>
    ${ui.parsing ? `<p class="note" style="margin-top:10px">${esc(ui.parsing)}</p>` : ''}
    <div class="actions"><button class="btn-small" data-action="manual-payslip">Ingresar a mano</button></div>
  </section>`}

  <section class="card">
    <h2>Historial de sueldo</h2>
    ${barChart(series, { ariaLabel: 'Ingreso real por mes' })}
    <p class="small muted">Ingreso real = líquido + anticipo − reembolsos (viáticos, caja chica).</p>
    <div class="table-wrap"><table>
      <tr><th>Mes</th><th class="num">Líquido</th><th class="num">Ingreso real</th><th class="num">Bonos</th><th></th></tr>
      ${rows.slice().reverse().map(({ p, s }, i, arr) => {
    const prev = arr[i + 1]?.s;
    const diff = prev ? s.realIncome - prev.realIncome : null;
    return `<tr><td>${periodLabel(p.period)}${diff != null ? `<div class="small muted">${diff >= 0 ? '▲' : '▼'} ${money(Math.abs(diff))}</div>` : ''}</td>
      <td class="num">${money(s.netPay)}</td><td class="num">${money(s.realIncome)}</td><td class="num">${s.bonuses ? money(s.bonuses) : '—'}</td>
      <td><button class="btn-link" data-action="edit-payslip" data-id="${esc(p.id)}">Ver</button></td></tr>`;
  }).join('')}
    </table></div>
  </section>`;
}

function draftForm() {
  const d = ui.draft;
  return `<section class="card">
    <h2>Revisa los datos leídos</h2>
    <p class="small muted">Corrige cualquier monto mal leído. El resumen se actualiza al tiro.</p>
    <div class="row">
      <div><label>Mes</label><input type="month" data-draft="period" value="${esc(d.period || '')}"></div>
      <div><label>Líquido a pagar</label><input inputmode="numeric" data-draft="netPay" value="${esc(d.netPay ?? '')}"></div>
    </div>
    ${Object.keys(SECTION_LABELS).map((section) => `
      <div class="section-title">${SECTION_LABELS[section]}</div>
      ${d.items.filter((i) => i.section === section && !i.deleted).map((i) => `
        <div class="item-row">
          <input data-draft="item" data-id="${esc(i.id)}" data-field="label" value="${esc(i.label)}" aria-label="Concepto">
          <input data-draft="item" data-id="${esc(i.id)}" data-field="amount" inputmode="numeric" value="${esc(i.amount)}" aria-label="Monto">
          <button type="button" class="btn-small btn-danger" data-action="draft-del" data-id="${esc(i.id)}" aria-label="Quitar">✕</button>
          <select data-draft="item" data-id="${esc(i.id)}" data-field="kind" aria-label="Tipo">
            ${SECTION_KINDS[section].map((k) => `<option value="${k}" ${k === i.kind ? 'selected' : ''}>${KIND_LABELS[k]}</option>`).join('')}
          </select>
        </div>`).join('')}
      <button type="button" class="btn-link" data-action="draft-add" data-section="${section}">+ agregar en ${SECTION_LABELS[section].toLowerCase()}</button>`).join('')}
    <div id="draft-summary">${draftSummary(d)}</div>
    <div class="actions">
      <button class="btn-primary" data-action="draft-save">Guardar liquidación</button>
      <button data-action="draft-cancel">Cancelar</button>
      ${state.payslips.some((p) => p.id === d.id) ? '<button class="btn-danger" data-action="draft-delete">Eliminar</button>' : ''}
    </div>
  </section>`;
}

function draftSummary(d) {
  const s = summarize(d);
  const warnings = validate(d);
  const line = (label, v) => (v ? `<tr><td>${label}</td><td class="num">${money(v)}</td></tr>` : '');
  return `
    ${warnings.map((w) => `<div class="alert warning">⚠ ${esc(w)}</div>`).join('')}
    <h3 style="margin-top:12px">Resumen</h3>
    <table>
      ${line('Sueldo base', s.baseSalary)}${line('Gratificación', s.gratification)}${line('Horas extras', s.overtime)}
      ${line('Bonos', s.bonuses)}${line('Otros imponibles', s.otherTaxable)}${line('Movilización y colación', s.allowances)}
      ${line('Reembolsos recibidos', s.reimbursementsIn)}
      <tr><td>AFP</td><td class="num">${money(-s.afp)}</td></tr>
      <tr><td>Salud ${d.healthSystem ? `(${esc(d.healthSystem)})` : ''}</td><td class="num">${money(-s.health)}</td></tr>
      <tr><td>Seguro de cesantía</td><td class="num">${money(-s.unemployment)}</td></tr>
      <tr><td>Impuesto único</td><td class="num">${money(-s.incomeTax)}</td></tr>
      ${line('Anticipo (ya recibido el 15)', -s.advance)}
      ${s.payrollLoans.map((l) => line(esc(l.label), -l.amount)).join('')}
      ${line('Otros descuentos', -s.otherDeductions)}
      <tr><th>Líquido a pagar</th><th class="num">${money(s.netPay)}</th></tr>
      <tr><th>Ingreso real del mes</th><th class="num">${money(s.realIncome)}</th></tr>
      ${s.bonusNet ? `<tr><td>de eso, bono líquido aprox. (va a ahorro)</td><td class="num">${money(s.bonusNet)}</td></tr>` : ''}
    </table>`;
}

function viewFood() {
  const today = todayISO();
  const plan = computePlan(state, today);
  const catalog = withPrices(CATALOG, state.settings.prices);
  const list = shoppingList(catalog, plan.foodWeekBudget);
  const weekStart = mondayOf(today);
  const checked = new Set(JSON.parse(lsGet(`finanzas.shop.${weekStart}`, '[]')));
  const month = Number(today.slice(5, 7));
  const homeInCycle = live(state.homeMeals).filter((m) => m.date >= plan.cycle.start && m.date <= plan.cycle.end);
  const homeToday = homeInCycle.filter((m) => m.date === today).length;
  const savedCooking = homeInCycle.length * Math.max(0, state.settings.deliveryPrice - state.settings.homeMealCost);
  const foodWeekSpent = sum(live(state.expenses).filter((e) => ['comida', 'supermercado', 'delivery'].includes(e.category) && e.date >= weekStart && e.date <= today));
  const groups = [...new Set(list.items.map((i) => i.group))];

  return `
  <section class="kpis">
    <article class="kpi"><p class="kpi-label">Presupuesto de comida hoy</p><p class="kpi-value">${money(Math.max(0, plan.foodToday))}</p>
      <p class="kpi-sub">Gastado hoy en comida: ${money(plan.foodSpentToday)}</p></article>
    <article class="kpi"><p class="kpi-label">Comida esta semana</p><p class="kpi-value">${money(foodWeekSpent)}</p>
      <p class="kpi-sub">de ${money(plan.foodWeekBudget)} (lun a dom)</p></article>
    <article class="kpi"><p class="kpi-label">Ahorro por cocinar en casa</p><p class="kpi-value">${money(savedCooking)}</p>
      <p class="kpi-sub">${homeInCycle.length} comidas caseras este ciclo vs delivery de ${money(state.settings.deliveryPrice)}</p></article>
  </section>

  <section class="card">
    <h2>¿Cocinaste hoy?</h2>
    <p class="small muted">Cada comida casera en vez de delivery es plata que se queda contigo.</p>
    <div class="actions"><button class="btn-primary" data-action="home-meal">🍳 Cociné en casa (${homeToday} hoy)</button>
    ${homeToday ? '<button class="btn-small" data-action="home-meal-undo">Deshacer</button>' : ''}</div>
  </section>

  <section class="card">
    <h2>Ideas de comidas</h2>
    <p class="small muted">Saciadoras y económicas, con productos de supermercado y feria. Fruta de temporada (${MONTH_NAMES[month - 1]}): ${SEASONAL_FRUIT[month]}.</p>
    ${['Desayuno', 'Almuerzo', 'Cena', 'Colación'].map((type) => `
      <h3 class="section-title">${type}</h3>
      ${MEALS.filter((m) => m.type === type).map((m) => `
        <div class="meal"><div><div>${esc(m.name)}</div><div class="small muted">${esc(m.why)}</div></div>
        <div style="text-align:right"><div class="amount">${money(m.cost)}</div>${m.cost <= plan.foodToday ? '<span class="badge good">cabe hoy</span>' : ''}</div></div>`).join('')}`).join('')}
  </section>

  <section class="card">
    <div class="split"><h2>Lista de compras semanal</h2><span class="amount">${money(list.total)}</span></div>
    <p class="small muted">Ajustada a tu presupuesto semanal de comida (${money(plan.foodWeekBudget)}). Precios estimados; edítalos abajo según tu súper o feria.</p>
    ${list.items.length < CATALOG.length ? `<p class="small">Se quitaron ${CATALOG.length - list.items.length} productos opcionales para no pasarte del presupuesto.</p>` : ''}
    ${groups.map((g) => `<div class="section-title">${esc(g)}</div>
      ${list.items.filter((i) => i.group === g).map((i) => `
        <div class="check-row ${checked.has(i.id) ? 'done' : ''}">
          <input type="checkbox" id="shop-${i.id}" data-change="shop-check" data-id="${esc(i.id)}" ${checked.has(i.id) ? 'checked' : ''}>
          <label for="shop-${i.id}">${esc(i.name)} <span class="muted small">${i.qty} × ${esc(i.unit)}</span></label>
          <span class="amount">${money(i.price * i.qty)}</span>
        </div>`).join('')}`).join('')}
    <details><summary>Editar precios</summary>
      <form data-form="prices" autocomplete="off">
        ${catalog.map((i) => `<div class="split" style="margin:6px 0"><label for="pr-${i.id}" style="margin:0">${esc(i.name)} (${esc(i.unit)})</label>
          <input id="pr-${i.id}" name="${i.id}" inputmode="numeric" value="${i.price}" style="max-width:110px"></div>`).join('')}
        <button class="btn-primary btn-small" type="submit">Guardar precios</button>
      </form>
    </details>
  </section>

  ${weightCard()}

  <section class="card">
    <h2>Hábitos que sí se sostienen</h2>
    <ul>${HABITS.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
    <div class="note">🩺 Esta app da ideas generales, no reemplaza a un profesional. Lo ideal es complementar con un nutricionista o médico, sobre todo para definir tu meta de peso y revisar exámenes. En el consultorio (Fonasa) puedes pedir hora con nutricionista.</div>
  </section>`;
}

function weightCard() {
  const weights = live(state.weights).sort((a, b) => a.id.localeCompare(b.id));
  const points = weights.map((w) => ({
    label: fmtDate(w.id, { day: 'numeric', month: 'short' }),
    value: w.kg,
    tip: `Semana del ${fmtDate(w.id, { day: 'numeric', month: 'short' })}\n${w.kg} kg`,
  }));
  const first = weights[0];
  const last = weights.at(-1);
  const recent = weights.slice(-5);
  const rate = recent.length >= 2 ? (recent[0].kg - recent.at(-1).kg) / (recent.length - 1) : null;
  let msg = '';
  if (rate != null && rate > 1.2) msg = '<div class="alert warning">Estás bajando más de 1 kg por semana en promedio. Ojo: lo sostenible es 0,5–1 kg por semana. Conversa con un profesional.</div>';
  else if (rate != null && rate >= 0.3) msg = '<div class="alert good">Vas a un ritmo sostenible. ¡Sigue así!</div>';
  return `<section class="card">
    <h2>Peso semanal</h2>
    <p class="small muted">Pésate una vez por semana, mismo día y hora. El número diario sube y baja por agua; lo que importa es la tendencia.</p>
    <form data-form="weight" class="inline-form" autocomplete="off">
      <input name="kg" inputmode="decimal" placeholder="kg" aria-label="Peso en kilos" value="">
      <input name="date" type="date" value="${todayISO()}" aria-label="Fecha">
      <button class="btn-primary btn-small" type="submit">Guardar</button>
    </form>
    ${lineChart(points, { unit: ' kg', ariaLabel: 'Evolución del peso semanal' })}
    ${first && last && first !== last ? `<p>Desde el inicio: <strong>${(last.kg - first.kg).toFixed(1).replace('.', ',')} kg</strong> en ${weights.length - 1} semanas.</p>` : ''}
    ${msg}
    ${weights.length ? `<details><summary>Ver tabla</summary><ul class="list">${weights.slice().reverse().map((w) => `<li><span>Semana del ${fmtDate(w.id, { day: 'numeric', month: 'long' })}</span>
      <span><span class="amount">${esc(String(w.kg).replace('.', ','))} kg</span> <button class="btn-link btn-danger" data-action="del-weight" data-id="${esc(w.id)}" aria-label="Eliminar">✕</button></span></li>`).join('')}</ul></details>` : ''}
  </section>`;
}

function viewMore() {
  const s = state.settings;
  const sync = loadSyncConfig();
  return `
  <form class="card" data-form="settings" autocomplete="off">
    <h2>Ajustes</h2>
    <div class="row">
      <div><label>Meta de ahorro (%)</label><input name="savingsRate" inputmode="numeric" value="${esc(Math.round(s.savingsRate * 100))}"></div>
      <div><label>Parte del diario para comida (%)</label><input name="foodShare" inputmode="numeric" value="${esc(Math.round(s.foodShare * 100))}"></div>
    </div>
    <div class="row">
      <div><label>Anticipo mensual</label><input name="advanceAmount" inputmode="numeric" value="${esc(s.advanceAmount)}"></div>
      <div><label>Día del anticipo</label><input name="advanceDay" inputmode="numeric" value="${esc(s.advanceDay)}"></div>
    </div>
    <div class="row">
      <div><label>Ingreso mensual manual (opcional)</label><input name="expectedIncome" inputmode="numeric" value="${esc(s.expectedIncome ?? '')}" placeholder="Usa la liquidación"></div>
      <div><label>Gasto hormiga hasta</label><input name="antThreshold" inputmode="numeric" value="${esc(s.antThreshold)}"></div>
    </div>
    <div class="row">
      <div><label>Precio típico de un delivery</label><input name="deliveryPrice" inputmode="numeric" value="${esc(s.deliveryPrice)}"></div>
      <div><label>Costo de una comida casera</label><input name="homeMealCost" inputmode="numeric" value="${esc(s.homeMealCost)}"></div>
    </div>
    <button class="btn-primary" type="submit">Guardar ajustes</button>
    <p class="small muted">Esquema acordado: mientras tengas tarjetas con saldo, sus cuotas cuentan dentro del 30%. El resto del 30% va a un fondo de emergencia. Cada tarjeta que terminas libera su cuota hacia ahorro real.</p>
  </form>

  <section class="card">
    <h2>Sincronizar entre equipos (GitHub)</h2>
    ${sync ? `<p>Conectado a <strong>${esc(sync.owner)}/${esc(sync.repo)}</strong> (${esc(sync.path)}).</p>
      <div class="actions"><button class="btn-primary" data-action="sync-now">Sincronizar ahora</button>
      <button class="btn-danger" data-action="sync-off">Desconectar este equipo</button></div>` : `
    <p class="small muted">Tus datos se guardan en un archivo dentro de un repositorio <strong>privado</strong> tuyo. Necesitas un token "fine-grained" con permiso <em>Contents: Read and write</em> solo para ese repositorio. El token queda guardado únicamente en este navegador.</p>
    <form data-form="sync" autocomplete="off">
      <div class="row">
        <div><label>Usuario de GitHub</label><input name="owner" required></div>
        <div><label>Repositorio privado de datos</label><input name="repo" required value="finanzas-datos"></div>
      </div>
      <div class="row">
        <div><label>Archivo</label><input name="path" value="data.json"></div>
        <div><label>Token</label><input name="token" type="password" required autocomplete="off"></div>
      </div>
      <button class="btn-primary" type="submit">Conectar y sincronizar</button>
    </form>`}
  </section>

  <section class="card">
    <h2>Respaldo</h2>
    <p class="small muted">Descarga una copia de tus datos o importa una (se combina con lo que ya tienes, no lo borra).</p>
    <div class="actions">
      <button data-action="export">⬇ Exportar respaldo</button>
      <label class="btn" style="display:inline-flex;align-items:center;margin:0">⬆ Importar<input type="file" accept="application/json,.json" data-change="import" hidden></label>
    </div>
  </section>`;
}

// ---------- payslip reading ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

async function pdfToText(file) {
  await loadScript(PDFJS);
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  // isEvalSupported: false mitigates CVE-2024-4367 (font-based code execution) in pdf.js < 4.2.67.
  const doc = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const textLength = content.items.reduce((a, it) => a + it.str.trim().length, 0);
    if (textLength < 20) {
      // Scanned PDF (image only): render the page and read it with OCR.
      ui.parsing = `El PDF es una imagen escaneada; leyendo página ${n} con OCR…`;
      render();
      const scaled = page.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = scaled.width;
      canvas.height = scaled.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      pages.push(await imageToText(blob));
      continue;
    }
    const words = content.items.map((it) => ({ text: it.str, x: it.transform[4], y: viewport.height - it.transform[5] }));
    pages.push(wordsToText(words, viewport.width));
  }
  // Multi-page files are read page by page; the first page with a net pay wins.
  return pages.find((t) => /L[IÍ]QUIDO A (RECIBIR|PAGAR)\s*:?\s*\$?\s*\d/i.test(t)) || pages[0] || '';
}

async function imageToText(file) {
  await loadScript(TESSERACT);
  const bitmap = await createImageBitmap(file);
  const { data } = await window.Tesseract.recognize(file, 'spa', {
    logger: (m) => {
      if (m.status === 'recognizing text') { ui.parsing = `Leyendo la foto… ${Math.round(m.progress * 100)}%`; render(); }
    },
  });
  const words = (data.words || []).map((w) => ({ text: w.text, x: w.bbox.x0, y: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 }));
  const heights = words.map((w) => w.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 10;
  return wordsToText(words, bitmap.width, median * 0.6);
}

async function readPayslipFile(file) {
  ui.parsing = file.type === 'application/pdf' ? 'Leyendo el PDF…' : 'Preparando la lectura de la foto (puede tardar un poco)…';
  render();
  try {
    const text = file.type === 'application/pdf' ? await pdfToText(file) : await imageToText(file);
    const parsed = parsePayslipText(text);
    ui.draft = { id: newId('p'), source: file.type === 'application/pdf' ? 'pdf' : 'image', ...parsed };
    if (!parsed.items.length) toast('No pude leer los ítems. Revísalos e ingrésalos a mano.');
    ui.parsing = '';
  } catch (err) {
    console.error(err);
    ui.parsing = `No se pudo leer el archivo (${err.message}). Puedes ingresarla a mano.`;
  }
  render();
}

// ---------- actions ----------

const actions = {
  'gmail-cancel'() {
    ui.gmail.rows = null;
    render();
  },
  'gmail-forget'() {
    revokeGmailToken();
    saveGmailConfig(null);
    ui.gmail = { rows: null, loading: '', from: null };
    render();
    toast('Gmail desconectado de este equipo');
  },
  tab(el) {
    ui.tab = el.dataset.tab;
    lsSet('finanzas.tab', ui.tab);
    render();
    window.scrollTo(0, 0);
  },
  'del-expense'(el) {
    removeRecord('expenses', el.dataset.id);
    persist();
    toast('Gasto eliminado');
  },
  'save-leftover'(el) {
    upsert('savings', { id: newId('s'), date: todayISO(), amount: Number(el.dataset.amount), kind: 'leftover', cycle: el.dataset.cycle });
    persist();
    toast('Sobrante pasado a ahorro 💪');
  },
  'manual-payslip'() {
    const today = todayISO();
    ui.draft = { id: newId('p'), source: 'manual', period: today.slice(0, 7), netPay: null, items: [], sectionTotals: {}, healthSystem: null };
    render();
  },
  'edit-payslip'(el) {
    const p = state.payslips.find((x) => x.id === el.dataset.id);
    if (p) { ui.draft = structuredClone(p); render(); window.scrollTo(0, 0); }
  },
  'draft-add'(el) {
    const section = el.dataset.section;
    ui.draft.items.push({ id: newId('i'), section, label: '', amount: 0, kind: SECTION_KINDS[section].at(-1) });
    render();
  },
  'draft-del'(el) {
    ui.draft.items = ui.draft.items.filter((i) => i.id !== el.dataset.id);
    render();
  },
  'draft-cancel'() {
    ui.draft = null;
    render();
  },
  'draft-delete'() {
    if (!confirm('¿Eliminar esta liquidación del historial?')) return;
    removeRecord('payslips', ui.draft.id);
    ui.draft = null;
    persist();
  },
  'draft-save'() {
    const d = ui.draft;
    if (!d.period || !d.netPay) { toast('Falta el mes o el líquido a pagar.'); return; }
    const same = live(state.payslips).find((p) => p.period === d.period && p.id !== d.id);
    if (same && !confirm(`Ya tienes la liquidación de ${periodLabel(d.period)}. ¿Reemplazarla?`)) return;
    if (same) removeRecord('payslips', same.id);
    const { warnings, ...clean } = d;
    upsert('payslips', clean);
    ui.draft = null;
    persist();
    toast(`Liquidación de ${periodLabel(d.period)} guardada`);
  },
  'home-meal'() {
    upsert('homeMeals', { id: newId('m'), date: todayISO() });
    persist();
    toast(`¡Bien! Te ahorraste cerca de ${money(state.settings.deliveryPrice - state.settings.homeMealCost)}`);
  },
  'home-meal-undo'() {
    const today = todayISO();
    const last = live(state.homeMeals).filter((m) => m.date === today).at(-1);
    if (last) { removeRecord('homeMeals', last.id); persist(); }
  },
  'del-weight'(el) {
    removeRecord('weights', el.dataset.id);
    persist();
  },
  'sync-now'() {
    runSync(true);
  },
  'sync-off'() {
    if (!confirm('¿Desconectar este equipo de GitHub? Tus datos locales se mantienen.')) return;
    saveSyncConfig(null);
    ui.syncText = '';
    ui.syncError = false;
    render();
  },
  export() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `finanzas-respaldo-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};

const forms = {
  quick(form, submitter) {
    const amount = digits(form.amount.value);
    const category = submitter?.value;
    if (!amount) { toast('Escribe el monto primero.'); form.amount.focus(); return; }
    if (!category) { toast('Toca una categoría para guardar.'); return; }
    const now = Date.now();
    upsert('expenses', { id: newId('e'), date: todayISO(), amount, category, note: form.note.value.trim(), createdAt: now });
    persist();
    toast(`${catIcon(category)} ${money(amount)} en ${catLabel(category)}`);
  },
  expense(form) {
    const amount = digits(form.amount.value);
    if (!amount) return;
    upsert('expenses', { id: newId('e'), date: form.date.value, amount, category: form.category.value, note: form.note.value.trim(), createdAt: Date.now() });
    persist();
    toast('Gasto guardado');
  },
  'gmail-setup'(form) {
    const clientId = form.clientId.value.trim();
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      toast('Ese no parece un ID de cliente de Google (termina en .apps.googleusercontent.com).');
      return;
    }
    saveGmailConfig({ clientId });
    render();
    toast('Listo. Ahora puedes buscar tus cobros.');
  },
  'gmail-fetch'(form) {
    const config = loadGmailConfig();
    if (!config || ui.gmail.loading) return;
    const from = form.from.value || computePlan(state, todayISO()).cycle.start;
    ui.gmail.from = from;
    // Ask for the token first, still inside the submit gesture, so the Google popup is not blocked.
    const tokenPromise = requestGmailToken(config.clientId);
    setGmailStatus('Esperando el permiso de Google…');
    tokenPromise
      .then((tok) => {
        setGmailStatus('Buscando correos del banco…');
        return fetchBankMovements(tok, from, { onProgress: (done, total) => setGmailStatus(`Leyendo correos… ${done} de ${total}`) });
      })
      .then(({ movements, failed, truncated }) => {
        const rows = planImport(movements, state);
        ui.gmail.rows = rows.length ? rows : null;
        const notes = [
          truncated ? 'Había demasiados correos: se leyeron los 500 más recientes; elige una fecha "Desde" más cercana.' : '',
          failed ? `${failed} correo${failed === 1 ? '' : 's'} no se pudo leer.` : '',
        ].filter(Boolean).join(' ');
        if (!rows.length) toast(`No hay cobros nuevos desde el ${fmtDate(from)}. ${notes}`.trim());
        else if (notes) toast(notes);
      })
      .catch((err) => toast(err.message))
      .finally(() => {
        ui.gmail.loading = '';
        render();
      });
  },
  'gmail-import'(form) {
    const rows = ui.gmail.rows || [];
    let saved = 0;
    rows.forEach((r, i) => {
      const choice = form.elements[`a${i}`]?.value || 'skip';
      const [type, id] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)];
      if (type === 'cat' && CATEGORIES.some((x) => x.id === id)) {
        upsert('expenses', { id: newId('e'), date: r.date, amount: r.amount, category: id, note: r.description, createdAt: Date.now(), ref: r.ref });
        saved++;
      } else if (type === 'debt') {
        const debt = live(state.debts).find((d) => d.id === id);
        if (debt) { payDebt(debt, r.amount, r.date, r.ref); saved++; }
      }
      upsert('importedRefs', { id: r.ref });
    });
    ui.gmail.rows = null;
    persist();
    toast(saved ? `${saved} movimiento${saved === 1 ? '' : 's'} guardado${saved === 1 ? '' : 's'}` : 'Listo: no se guardó ningún movimiento.');
  },
  opening(form) {
    const plan = computePlan(state, todayISO());
    upsert('cycleNotes', { id: plan.cycle.start, openingSpent: digits(form.amount.value) });
    persist();
    toast('Ajuste guardado');
  },
  saving(form) {
    const amount = digits(form.amount.value);
    if (!amount) return;
    upsert('savings', { id: newId('s'), date: todayISO(), amount, kind: 'emergency' });
    persist();
    toast('Ahorro registrado 💰');
  },
  'debt-add'(form) {
    upsert('debts', {
      id: newId('d'),
      name: form.name.value.trim(),
      type: form.type.value,
      payment: digits(form.payment.value),
      dueDay: optionalNumber(form.dueDay.value),
      balance: optionalNumber(form.balance.value),
      installmentsLeft: optionalNumber(form.installmentsLeft.value),
      rate: form.rate.value.trim() ? decimal(form.rate.value) : null,
    });
    persist();
    toast('Deuda agregada');
  },
  'debt-edit'(form, submitter) {
    const d = state.debts.find((x) => x.id === form.dataset.id);
    if (!d) return;
    if (submitter?.value === 'delete') {
      if (!confirm(`¿Eliminar ${d.name}?`)) return;
      removeRecord('debts', d.id);
    } else {
      upsert('debts', {
        ...d,
        name: form.name.value.trim() || d.name,
        payment: digits(form.payment.value),
        dueDay: optionalNumber(form.dueDay.value),
        balance: optionalNumber(form.balance.value),
        installmentsLeft: optionalNumber(form.installmentsLeft.value),
        rate: form.rate.value.trim() ? decimal(form.rate.value) : null,
      });
    }
    persist();
  },
  'debt-pay'(form) {
    const d = state.debts.find((x) => x.id === form.dataset.id);
    const amount = digits(form.amount.value);
    if (!d || !amount) return;
    const next = payDebt(d, amount, todayISO());
    persist();
    toast(isDebtActive(next) ? 'Pago registrado' : `¡${d.name} pagada por completo! 🎉`);
  },
  'fixed-add'(form) {
    const kind = form.kind.value;
    const category = form.category.value;
    if (kind === 'envelope' && !category) { toast('Elige la categoría del sobre.'); return; }
    upsert('fixedExpenses', {
      id: newId('f'), name: form.name.value.trim(), amount: digits(form.amount.value),
      dueDay: optionalNumber(form.dueDay.value), kind, category: kind === 'envelope' ? category : null,
    });
    persist();
    toast('Gasto fijo agregado');
  },
  'fixed-edit'(form, submitter) {
    const f = state.fixedExpenses.find((x) => x.id === form.dataset.id);
    if (!f) return;
    if (submitter?.value === 'delete') {
      if (!confirm(`¿Eliminar ${f.name}?`)) return;
      removeRecord('fixedExpenses', f.id);
    } else {
      upsert('fixedExpenses', { ...f, amount: digits(form.amount.value), dueDay: optionalNumber(form.dueDay.value) });
    }
    persist();
    toast('Guardado');
  },
  weight(form) {
    const kg = decimal(form.kg.value);
    if (!kg || kg < 30 || kg > 300) { toast('Ingresa un peso válido en kilos.'); return; }
    upsert('weights', { id: mondayOf(form.date.value || todayISO()), kg: Math.round(kg * 10) / 10 });
    persist();
    toast('Peso guardado para esta semana');
  },
  prices(form) {
    const prices = {};
    for (const item of CATALOG) {
      const v = digits(form[item.id].value);
      if (v && v !== item.price) prices[item.id] = v;
    }
    updateSettings({ prices });
    persist();
    toast('Precios actualizados');
  },
  settings(form) {
    const pct = (v, fallback) => {
      const n = digits(v);
      return n > 0 && n <= 100 ? n / 100 : fallback;
    };
    const s = state.settings;
    updateSettings({
      savingsRate: pct(form.savingsRate.value, s.savingsRate),
      foodShare: pct(form.foodShare.value, s.foodShare),
      advanceAmount: digits(form.advanceAmount.value),
      advanceDay: Math.min(28, Math.max(1, digits(form.advanceDay.value) || 15)),
      expectedIncome: optionalNumber(form.expectedIncome.value) || null,
      antThreshold: digits(form.antThreshold.value) || 5000,
      deliveryPrice: digits(form.deliveryPrice.value) || 9000,
      homeMealCost: digits(form.homeMealCost.value) || 1500,
    });
    persist();
    toast('Ajustes guardados');
  },
  sync(form) {
    saveSyncConfig({
      owner: form.owner.value.trim(),
      repo: form.repo.value.trim(),
      path: form.path.value.trim() || 'data.json',
      token: form.token.value.trim(),
    });
    render();
    runSync(true);
  },
};

const changes = {
  'payslip-file'(input) {
    const file = input.files?.[0];
    if (file) readPayslipFile(file);
  },
  'shop-check'(input) {
    const key = `finanzas.shop.${mondayOf(todayISO())}`;
    const set = new Set(JSON.parse(lsGet(key, '[]')));
    if (input.checked) set.add(input.dataset.id); else set.delete(input.dataset.id);
    lsSet(key, JSON.stringify([...set]));
    input.closest('.check-row')?.classList.toggle('done', input.checked);
  },
  async import(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = normalizeState(JSON.parse(await file.text()));
      state = mergeStates(state, data);
      persist();
      toast('Respaldo importado');
    } catch {
      toast('El archivo no es un respaldo válido.');
    }
  },
};

function onDraftInput(el) {
  const d = ui.draft;
  if (!d) return;
  const kind = el.dataset.draft;
  if (kind === 'period') d.period = el.value;
  else if (kind === 'netPay') d.netPay = digits(el.value);
  else if (kind === 'item') {
    const item = d.items.find((i) => i.id === el.dataset.id);
    if (!item) return;
    const field = el.dataset.field;
    if (field === 'amount') item.amount = digits(el.value);
    else if (field === 'label') {
      item.label = el.value;
      const guess = classify(item.section, el.value);
      const select = el.parentElement.querySelector('select');
      if (select && !item.kindTouched) { item.kind = guess; select.value = guess; }
    } else if (field === 'kind') {
      item.kind = el.value;
      item.kindTouched = true;
    }
  }
  const box = document.getElementById('draft-summary');
  if (box) box.innerHTML = draftSummary(d);
}

// ---------- wiring ----------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  actions[el.dataset.action]?.(el, e);
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(form, e.submitter);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) changes[el.dataset.change]?.(el, e);
  else if (e.target.closest('[data-draft]')) onDraftInput(e.target);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-draft]');
  if (el) onDraftInput(el);
});

const tip = document.getElementById('tip');
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el || !el.dataset.tip) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12);
  const y = Math.max(8, e.clientY - tip.offsetHeight - 12);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});
document.addEventListener('pointerleave', () => { tip.hidden = true; });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    render();
    runSync();
  }
});

render();
runSync();
