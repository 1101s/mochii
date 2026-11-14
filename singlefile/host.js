import { Transport } from './transport.js';
import { PageResources } from './rewrite.js';
import { httpUrl, MAX_PAGE } from './protocol.js';
import appDocuments from 'singlefile:apps';
import gameCatalog from '../browser-tools/game-catalog.json';
import musicCatalog from '../browser-tools/music-catalog.json';

const config = globalThis.MochiiConfig.staticConfig('https://mochii.invalid');
const endpoints = config.wispEndpoints.map(item => item.url);
let session, preparing, preparingFrame, generation = 0;
const nativeFetch = window.fetch.bind(window);
const latestNetwork = { status: 'idle', configuredCount: endpoints.length };
const transport = new Transport(endpoints, state => {
  Object.assign(latestNetwork, state);
  window.networkStatusChanged?.(state);
  session?.tools?.postMessage({ event: 'network', data: state });
});
const mediaTransport = new Transport(endpoints);
const mediaURLs = new Map();
let mediaBytes = 0;

function disposeSession(value) {
  if (!value) return;
  clearTimeout(value.readyTimer);
  value.abort.abort(); value.port?.close(); value.tools?.close(); value.resources.dispose();
}
function errorText(error) { return String(error?.message || error).slice(0, 1000); }
function showError(error) { window.showViewerProgress?.(errorText(error), true); }

async function load(address, options = {}, frame = document.getElementById('viewer-frame')) {
  const url = httpUrl(address);
  const id = ++generation;
  preparing?.abort();
  // A new navigation owns a new transport lifetime. Cancel the old page's
  // outstanding relay requests before beginning; no background requests survive.
  session?.abort.abort();
  transport.reset();
  const abort = new AbortController(); preparing = abort; preparingFrame = frame;
  const resources = new PageResources(transport, abort.signal);
  const next = { abort, resources, frame, url, token: crypto.randomUUID(), tools: null, port: null, lastPage: null, requests: 0, queuedTools: [] };
  try {
    window.showViewerProgress?.('Fetching page through Wisp…');
    const response = await resources.fetch(url, options);
    next.url = response.url || url;
    const type = response.headers.get('content-type') || '';
    let content = await response.text();
    if (!/html|xhtml|text\/plain/i.test(type) && !/^\s*<!doctype html|^\s*<html/i.test(content)) {
      const doc = document.implementation.createHTMLDocument('Response');
      const pre = doc.createElement('pre'); pre.textContent = content; doc.body.append(pre); content = doc.documentElement.outerHTML;
    }
    const html = await resources.document(content, next.url, next.token);
    if (id !== generation) throw new DOMException('Navigation superseded', 'AbortError');
    disposeSession(session); session = next; preparing = null; preparingFrame = null;
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-pointer-lock' + (window.MochiiPrivacy?.get().allowDownloads !== false ? ' allow-downloads' : ''));
    frame.src = 'about:blank';
    frame.srcdoc = html;
    next.readyTimer = setTimeout(() => { if (session === next && !next.port) showError(new Error('The page bridge did not start. This SVG host may block inline scripts or blob resources.')); }, 12000);
    if (resources.warnings.size) window.showViewerProgress?.([...resources.warnings].slice(0, 2).join(' '));
    else window.showViewerProgress?.('');
    return true;
  } catch (error) {
    resources.dispose(); abort.abort();
    if (id === generation) { preparing = null; preparingFrame = null; showError(error); }
    throw error;
  }
}

async function broker(owner, data) {
  if (owner !== session || owner.abort.signal.aborted) return;
  if (++owner.requests > 32) { owner.requests--; owner.port.postMessage({ response: data.request, error: 'Too many concurrent page requests.' }); return; }
  try {
    const params = data.params || {};
    let result;
    if (data.method === 'navigate') {
      // Do not replay POST on retry/reload. Navigation is initiated exactly once.
      await load(httpUrl(params.url), { method: params.method || 'GET', headers: params.headers, body: params.body }, owner.frame);
      return;
    } else if (data.method === 'asset') {
      if (!['asset', 'script', 'css'].includes(params.kind)) throw new Error('Invalid resource type.');
      result = await owner.resources.asset(httpUrl(params.url), owner.url, params.kind);
    } else if (data.method === 'fetch') {
      const response = await owner.resources.fetch(httpUrl(params.url), { method: params.method, headers: params.headers, body: params.body });
      const body = await response.arrayBuffer();
      owner.resources.bytes += body.byteLength;
      if (owner.resources.bytes > MAX_PAGE) throw new Error('Page resource budget exceeded.');
      result = { status: response.status, statusText: response.statusText, headers: [...response.headers], url: response.url, body };
    } else throw new Error('Unsupported page request.');
    if (owner === session && !owner.abort.signal.aborted) owner.port.postMessage({ response: data.request, result });
  } catch (error) {
    if (owner === session) owner.port?.postMessage({ response: data.request, error: errorText(error) });
  } finally { owner.requests--; }
}

window.addEventListener('message', event => {
  const owner = session;
  if (!owner || event.source !== owner.frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'mochii:singlefile:ready' || event.data.token !== owner.token || owner.port) return;
  clearTimeout(owner.readyTimer);
  const channel = new MessageChannel(); owner.port = channel.port1;
  owner.port.onmessage = ({ data }) => {
    if (owner !== session || !data || typeof data !== 'object') return;
    if (Number.isSafeInteger(data.request)) { void broker(owner, data); return; }
    if (data.event === 'page') {
      try { data.data.url = httpUrl(data.data.url); } catch { return; }
      owner.lastPage = data;
      document.getElementById('browser-url').value = data.data.url;
    }
    owner.tools?.postMessage(data);
  };
  owner.port.start();
  owner.frame.contentWindow.postMessage({ type: 'mochii:singlefile:port', token: owner.token }, '*', [channel.port2]);
  for (const data of owner.queuedTools.splice(0)) owner.port.postMessage(data);
});

function connectTools() {
  const owner = session;
  if (!owner) throw new Error('Open a page first.');
  owner.tools?.close();
  const channel = new MessageChannel(); owner.tools = channel.port1;
  owner.tools.onmessage = async ({ data }) => {
    if (owner !== session || !data || !Number.isSafeInteger(data.id)) return;
    try {
      if (['navigate', 'reload', 'reconnect', 'switchServer'].includes(data.method)) {
        if (data.method === 'switchServer' || data.method === 'reconnect') {
          // A fresh worker closes the previous relay's sockets before selecting another.
          transport.reset();
          await transport.switchRelay();
          owner.tools?.postMessage({ id: data.id, result: true });
        } else {
          const destination = data.method === 'reload' ? owner.lastPage?.data.url || owner.url : httpUrl(data.params?.url);
          owner.tools?.postMessage({ id: data.id, result: true });
          void load(destination, {}, owner.frame).catch(showError);
        }
      } else if (owner.port) owner.port.postMessage(data);
      else if (owner.queuedTools.length < 32) owner.queuedTools.push(data);
      else throw new Error('Page tools are not ready.');
    } catch (error) { owner.tools?.postMessage({ id: data.id, error: errorText(error) }); }
  };
  owner.tools.start();
  // Events sent on a MessagePort are queued until the receiver starts it.
  owner.tools.postMessage({ event: 'network', data: latestNetwork });
  if (owner.lastPage) owner.tools.postMessage(owner.lastPage);
  return channel.port2;
}

async function mediaURL(value) {
  const url = httpUrl(value);
  const response = await mediaTransport.fetch(url);
  if (!response.ok) throw new Error(`Media request returned HTTP ${response.status}.`);
  const blob = await response.blob();
  // Keep a bounded cache; old media URLs are revoked instead of leaking memory.
  while (mediaURLs.size && (mediaURLs.size >= 40 || mediaBytes + blob.size > 96 * 1024 * 1024)) {
    const [key, entry] = mediaURLs.entries().next().value;
    URL.revokeObjectURL(entry.url); mediaBytes -= entry.size; mediaURLs.delete(key);
  }
  const previous = mediaURLs.get(url);
  if (previous) { URL.revokeObjectURL(previous.url); mediaBytes -= previous.size; }
  const result = URL.createObjectURL(blob); mediaURLs.set(url, { url: result, size: blob.size }); mediaBytes += blob.size;
  return result;
}

function close() {
  ++generation; preparing?.abort(); preparing = null; preparingFrame = null;
  disposeSession(session); session = null; transport.reset();
}
window.MochiiSinglefile = {
  load, close, connectTools, isPage: frame => session?.frame === frame,
  closeFrame: frame => { if (session?.frame === frame || preparingFrame === frame) close(); },
  mediaURL, retryMedia: () => mediaTransport.switchRelay(),
  async openLocal(path, frame) {
    close();
    if (path === '/flyflix.html') return load('https://flyflix.net/', {}, frame);
    if (!Object.hasOwn(appDocuments, path)) throw new Error('This local app is not bundled.');
    frame.removeAttribute('sandbox'); frame.src = 'about:blank'; frame.srcdoc = appDocuments[path];
  },
};

window.fetch = (input, options) => {
  const value = input instanceof Request ? input.url : String(input);
  const path = new URL(value, 'https://mochii.invalid/').pathname;
  const bundled = { '/browser-tools/game-catalog.json': gameCatalog, '/browser-tools/music-catalog.json': musicCatalog };
  if (Object.hasOwn(bundled, path) && (value.startsWith('/') || !/^https?:/i.test(value))) {
    options?.signal?.throwIfAborted();
    return Promise.resolve(new Response(JSON.stringify(bundled[path]), { headers: { 'content-type': 'application/json' } }));
  }
  if (value.startsWith('/') && path.startsWith('/api/')) return Promise.resolve(new Response('This endpoint requires a separately hosted API.', { status: 503 }));
  return nativeFetch(input, options);
};
window.addEventListener('pagehide', () => {
  close(); mediaTransport.reset();
  for (const entry of mediaURLs.values()) URL.revokeObjectURL(entry.url);
  mediaURLs.clear(); mediaBytes = 0;
});
