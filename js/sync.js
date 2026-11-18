// Sync the app state to a JSON file in a PRIVATE GitHub repository through the
// REST contents API. The token stays only in this device's localStorage.
import { mergeStates, normalizeState, encodeBase64Utf8, decodeBase64Utf8 } from './store.js';

const CONFIG_KEY = 'finanzas.sync';
const API = 'https://api.github.com';

export function loadSyncConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null;
  } catch {
    return null;
  }
}

export function saveSyncConfig(config) {
  try {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    else localStorage.removeItem(CONFIG_KEY);
  } catch { /* storage unavailable */ }
}

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function fileUrl({ owner, repo, path }) {
  const p = (path || 'data.json').split('/').map(encodeURIComponent).join('/');
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p}`;
}

async function fetchRemote(config) {
  const res = await fetch(`${fileUrl(config)}?t=${Date.now()}`, { headers: headers(config.token), cache: 'no-store' });
  if (res.status === 404) return { state: null, sha: null };
  if (!res.ok) throw new Error(await describe(res));
  const body = await res.json();
  return { state: normalizeState(JSON.parse(decodeBase64Utf8(body.content))), sha: body.sha };
}

async function describe(res) {
  if (res.status === 401) return 'Token inválido o vencido.';
  if (res.status === 403) return 'El token no tiene permiso de escritura en ese repositorio.';
  if (res.status === 404) return 'No se encontró el repositorio (revisa usuario y nombre).';
  let msg = '';
  try { msg = (await res.json()).message; } catch { /* ignore */ }
  return `GitHub respondió ${res.status}${msg ? `: ${msg}` : ''}`;
}

/** Pull remote, merge with local, push the merged result. Returns the merged state. */
export async function syncNow(config, localState, attempt = 0) {
  const { state: remote, sha } = await fetchRemote(config);
  const merged = remote ? mergeStates(remote, localState) : normalizeState(localState);
  const body = {
    message: `sync: ${new Date().toISOString()}`,
    content: encodeBase64Utf8(JSON.stringify(merged)),
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(fileUrl(config), {
    method: 'PUT',
    headers: { ...headers(config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((res.status === 409 || res.status === 422) && attempt < 2) {
    return syncNow(config, merged, attempt + 1); // another device wrote in between
  }
  if (!res.ok) throw new Error(await describe(res));
  return merged;
}
