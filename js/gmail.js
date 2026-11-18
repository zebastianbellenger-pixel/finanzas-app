// Read-only Gmail access from the browser via Google Identity Services (token flow).
// The access token lives only in memory and expires in about an hour; the OAuth client ID
// (not a secret) is stored per device. Email contents never leave the browser.
import { parseBankEmail, messageBody, gmailQuery, base64UrlToBytes } from './bankmail.js';

const CONFIG_KEY = 'finanzas.gmail';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CLIENT_ID_PATTERN = /^[\w-]+\.apps\.googleusercontent\.com$/;
const MAX_MESSAGES = 500;
const CONCURRENCY = 5;

export function loadGmailConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    return c && CLIENT_ID_PATTERN.test(c.clientId) ? { clientId: c.clientId } : null;
  } catch {
    return null;
  }
}

export function saveGmailConfig(config) {
  token = null;
  try {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify({ clientId: config.clientId }));
    else localStorage.removeItem(CONFIG_KEY);
  } catch { /* storage unavailable */ }
}

let gisPromise = null;
/** Loads the Google Identity Services script once. Call early so the click can open the popup directly. */
export function preloadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(new Error('No se pudo cargar el inicio de sesión de Google. Revisa tu conexión.')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

let token = null; // { value, expiresAt }

/** Asks Google for a read-only Gmail token. Must be called from a click/submit handler. */
export async function requestGmailToken(clientId) {
  if (token && token.expiresAt > Date.now()) return token.value;
  if (!globalThis.google?.accounts?.oauth2) await preloadGis();
  return new Promise((resolve, reject) => {
    const client = globalThis.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error('Google no dio permiso para leer los correos.'));
          return;
        }
        if (!globalThis.google.accounts.oauth2.hasGrantedAllScopes(resp, GMAIL_SCOPE)) {
          reject(new Error('Necesitas marcar el permiso para ver tus correos de Gmail.'));
          return;
        }
        token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
        resolve(token.value);
      },
      error_callback: (err) => {
        reject(new Error(err?.type === 'popup_closed'
          ? 'Cerraste la ventana de Google antes de dar permiso.'
          : 'El navegador bloqueó la ventana de Google. Permite ventanas emergentes y vuelve a intentarlo.'));
      },
    });
    client.requestAccessToken({ prompt: '' });
  });
}

/** Forgets the in-memory token and revokes it at Google. */
export function revokeGmailToken() {
  const value = token?.value;
  token = null;
  if (value) globalThis.google?.accounts?.oauth2?.revoke?.(value, () => {});
}

const header = (msg, name) => (msg.payload?.headers || []).find((h) => String(h.name).toLowerCase() === name)?.value ?? '';

class AuthError extends Error {}

function gmailApi(accessToken, fetchImpl) {
  return async (path) => {
    const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) {
      token = null;
      throw new AuthError('El permiso de Google expiró. Vuelve a intentarlo.');
    }
    if (!res.ok) throw new Error(`Gmail respondió ${res.status}. Vuelve a intentarlo en un rato.`);
    return res.json();
  };
}

async function listIds(api, query) {
  const ids = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ q: query, maxResults: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await api(`/messages?${q}`);
    ids.push(...(page.messages || []).map((m) => m.id));
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < MAX_MESSAGES);
  return { ids, truncated: Boolean(pageToken) };
}

/**
 * Lists bank emails since fromISO and returns { movements (newest first), failed, truncated }:
 * failed counts messages that could not be fetched (skipped, not fatal); truncated is true when
 * more than MAX_MESSAGES emails matched. fetchImpl is injectable for tests.
 */
export async function fetchBankMovements(accessToken, fromISO, { fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
  const api = gmailApi(accessToken, fetchImpl);
  const { ids, truncated } = await listIds(api, gmailQuery(fromISO));
  const movements = [];
  let failed = 0;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = await Promise.allSettled(ids.slice(i, i + CONCURRENCY)
      .map((id) => api(`/messages/${encodeURIComponent(id)}?format=full`)));
    for (const result of batch) {
      if (result.status === 'rejected') {
        if (result.reason instanceof AuthError) throw result.reason;
        failed++;
        continue;
      }
      const msg = result.value;
      const m = parseBankEmail({
        id: msg.id,
        from: header(msg, 'from'),
        subject: header(msg, 'subject'),
        date: new Date(Number(msg.internalDate) || 0).toISOString(),
        text: messageBody(msg.payload),
      });
      if (m && m.date >= fromISO) movements.push(m);
    }
    onProgress(Math.min(ids.length, i + CONCURRENCY), ids.length);
  }
  return { movements: movements.sort((a, b) => b.date.localeCompare(a.date)), failed, truncated };
}

function pdfParts(part, out = []) {
  if (!part) return out;
  if (Array.isArray(part.parts)) part.parts.forEach((p) => pdfParts(p, out));
  if (part.body?.attachmentId && /\.pdf$/i.test(part.filename || '')) out.push(part);
  return out;
}

/**
 * Downloads the PDF of every Banco de Chile "Cartola" email since fromISO that is not in `skip`
 * (a Set of "gmail:<id>" refs). Returns [{ ref, filename, date, bytes }] (bytes: Uint8Array, still encrypted).
 */
export async function fetchCartolaFiles(accessToken, fromISO, { fetchImpl = globalThis.fetch, skip = new Set() } = {}) {
  const api = gmailApi(accessToken, fetchImpl);
  const after = gmailQuery(fromISO).split(' ').pop();
  const { ids } = await listIds(api, `from:bancochile.cl subject:cartola has:attachment ${after}`);
  const files = [];
  for (const id of ids.filter((x) => !skip.has(`gmail:${x}`))) {
    const msg = await api(`/messages/${encodeURIComponent(id)}?format=full`);
    for (const part of pdfParts(msg.payload)) {
      const att = await api(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
      files.push({
        ref: `gmail:${id}`, filename: part.filename, date: new Date(Number(msg.internalDate) || 0).toISOString().slice(0, 10),
        bytes: base64UrlToBytes(att.data),
      });
    }
  }
  return files;
}
