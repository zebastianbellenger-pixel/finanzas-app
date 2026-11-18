# Mis Finanzas

A personal single-page web app (phone and desktop) for a Chilean salary: reads Buk payslips, splits the 30% savings goal, computes how much can be spent today, tracks debts, and supports healthy eating on a budget. UI in Spanish, amounts in CLP. No build step, no backend.

## Run locally

ES modules need an HTTP server (opening `index.html` with `file://` will not work). Requires Node.js 20+, no dependencies.

- **Windows**: double-click `iniciar.cmd`. It starts the server and opens the browser; close the window to stop it. To get a **Mis Finanzas** shortcut on the Desktop, double-click `crear-acceso-directo.cmd` once per computer (it runs `scripts/create-shortcut.ps1`; the shortcut starts minimized).
- **Any OS**:

```bash
npm start          # serve on http://localhost:5173 and open the browser
npm run serve      # serve only (PORT=8080 npm run serve for another port)
npm test           # unit tests
```

The server (`scripts/serve.mjs`) listens on 127.0.0.1 only, so other devices on the network cannot reach it. If the port is busy, it assumes the app is already running and just opens it.

## How the numbers work

- **Pay cycle**: from the last business day of a month (Chilean holidays included) to the day before the next one. The advance (anticipo) arrives on the 15th inside the cycle.
- **Cycle income**: net pay + advance − net reimbursements (viáticos, caja chica). One-off bonuses are excluded and go to savings or debt.
- **30% scheme**: while credit cards have a balance, their monthly payments count toward the 30%; the rest of the 30% goes to an emergency fund. Paying off a card frees its payment toward real savings.
- **Daily allowance**: (income − max(30%, card payments) − fixed expenses − loans/installments − already spent) ÷ days left. Recomputed every time an expense is logged.
- **Envelopes** (e.g. diesel): monthly budgets for a category; spending in that category only reduces the daily allowance when it exceeds the envelope.
- **Food**: a share of the daily base (default 50%) as a Monday–Sunday budget, spread over the days left in the week.

## Payslips

Upload the PDF downloaded from the Buk portal. The text is extracted in the browser with pdf.js (scanned PDFs and photos go through Tesseract OCR). Nothing is uploaded anywhere. Every value can be corrected before saving. The app never logs into Buk, Servipag or any other site, and never stores those passwords.

## Import charges from Gmail

**Gastos → Importar cobros desde Gmail** reads bank notification emails and lists the outgoing movements for review before anything is saved:

| Email (Banco de Chile) | Imported as (default) |
|---|---|
| Cargo en Cuenta (purchase) | Expense, category guessed from the merchant |
| Transferencia a Terceros | Payment of a debt whose name matches the beneficiary (e.g. "CMR"), otherwise an "Otros" expense |
| Pago de Comercios (Servipag) | Not saved: bills already count as fixed expenses |
| Pago Crédito Consumo | Not saved unless you pick the debt |

Incoming transfers, transfers between your own accounts, statements and marketing are ignored. An expense you already logged by hand (same amount, ±1 day) defaults to "No registrar". Every reviewed email, saved or not, is remembered and never offered again. BancoEstado is included in the search, but only its incoming-transfer notices have been seen so far; purchase notices need a sample before they can be parsed.

Privacy: the app asks Google for **read-only** Gmail access (`gmail.readonly`). The access token stays in memory for about an hour and is never stored or synced; email contents are parsed in the browser and only amount, date and merchant are saved.

One-time setup (about 10 minutes):

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library**: enable **Gmail API**.
3. **Google Auth Platform** (OAuth consent screen): audience **External**, keep it in **Testing**, and add your Gmail address as a **test user**.
4. **Clients → Create client**: type **Web application**; under **Authorized JavaScript origins** add the exact origin you open the app from (e.g. `http://localhost:5173`; `localhost` and `127.0.0.1` are different origins).
5. Paste the **Client ID** into the app. Google will warn that the app is unverified: it is your own app, choose **Continue**.

The Client ID is not a secret and is stored only in that browser. **Desconectar Gmail de este equipo** removes it and revokes the token.

## Sync between devices (GitHub)

Data lives in the browser (`localStorage`) and can sync to a JSON file in a **private** repository:

1. Create a private repo, e.g. `finanzas-datos` (it can be empty).
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to **only that repository** and permission **Contents: Read and write**. Set an expiration.
3. In the app: **Más → Sincronizar entre equipos**, enter user, repo and token. Repeat on each device.

The token is stored only in that browser's `localStorage`. Use a token scoped to the data repo only, so a leaked token cannot touch anything else. Records merge per item (last change wins) and deletions propagate.

## Hosting

Any static host works (GitHub Pages, Netlify, Cloudflare Pages). The code contains no personal data; personal data lives only in the browser and in the private data repo. Test fixtures are synthetic. `seed/` (one-time local imports via **Más → Respaldo → Importar**) and `odd/` (local working notes) are git-ignored because they hold personal data: never commit them, and keep the code repository private if in doubt.

## Project layout

```
iniciar.cmd       Windows launcher (double-click)
crear-acceso-directo.cmd  creates the Desktop shortcut
scripts/create-shortcut.ps1  shortcut creation script
scripts/serve.mjs local static server
index.html        app shell
css/styles.css    styles (light/dark tokens)
js/cycle.js       pay cycle + Chilean holidays
js/payslip.js     payslip text extraction/parsing (Buk format)
js/budget.js      plan, daily allowance, alerts, debts, shopping list
js/food.js        meal ideas, catalog with estimated prices, seasonal fruit
js/store.js       local persistence + merge
js/sync.js        GitHub contents API sync
js/bankmail.js    bank email parsing and import planning
js/gmail.js       Gmail read-only client (Google Identity Services)
js/charts.js      inline SVG charts
js/app.js         UI
tests/            node:test unit tests
```

Disclaimer: the food and weight guidance is general. It does not replace a nutritionist or physician.
