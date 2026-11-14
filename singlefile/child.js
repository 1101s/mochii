import { attachRuntime, formatValue } from '../browser-tools/runtime.js';
import { httpUrl } from './protocol.js';
import { createRequestQueue } from './request-queue.js';
import { hideServiceWorker } from './sandbox-compat.js';

hideServiceWorker(navigator);

const { token, address, base } = globalThis.__mochiiPage;
delete globalThis.__mochiiPage;
let port, serial = 0, runtime;
const pending = new Map();
const waiting = [];
let currentAddress = address;
const nativeSet = Element.prototype.setAttribute;
const send = data => port ? port.postMessage(data) : waiting.push(data);
const emit = (event, data) => send({ event, data });
const enqueue = createRequestQueue();
function request(method, params = {}) {
  return enqueue(() => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Proxy request timed out.')); }, 50000);
    pending.set(id, { resolve, reject, timer });
    send({ request: id, method, params });
  }));
}
function navigate(url, options = {}) {
  return request('navigate', { url: httpUrl(url, currentAddress), ...options });
}
function cancellable(task, signal) {
  if (!signal) return task;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
window.fetch = async (input, options = {}) => {
  const source = input instanceof Request ? input : null;
  const url = httpUrl(source ? source.url : String(input), base);
  const method = options.method || source?.method || 'GET';
  const headers = new Headers(options.headers || source?.headers);
  let body = options.body;
  if (body === undefined && source && !['GET', 'HEAD'].includes(method)) body = await source.clone().arrayBuffer();
  if (body != null && !(body instanceof ArrayBuffer)) {
    const normalized = new Request(url, { method, headers, body });
    body = await normalized.arrayBuffer();
    normalized.headers.forEach((v, k) => headers.set(k, v));
  }
  const signal = options.signal || source?.signal;
  signal?.throwIfAborted();
  const result = await cancellable(request('fetch', { url, method, headers: [...headers], body }), signal);
  signal?.throwIfAborted();
  const response = new Response([204, 205, 304].includes(result.status) || method === 'HEAD' ? null : result.body, result);
  Object.defineProperty(response, 'url', { value: result.url });
  return response;
};

class ProxyXHR extends EventTarget {
  readyState = 0; status = 0; statusText = ''; response = null; responseText = ''; responseType = ''; timeout = 0; withCredentials = false;
  upload = new EventTarget();
  headers = new Headers(); responseHeaders = new Headers();
  event(name) { const event = new Event(name); this.dispatchEvent(event); this['on' + name]?.(event); }
  state(value) { this.readyState = value; this.event('readystatechange'); }
  open(method, url, async = true) {
    if (async === false) throw new Error('Synchronous XHR is unavailable in single-file mode.');
    this.method = method; this.url = httpUrl(url, base); this.headers = new Headers(); this.state(1);
  }
  setRequestHeader(name, value) { this.headers.append(name, value); }
  getResponseHeader(name) { return this.responseHeaders.get(name); }
  getAllResponseHeaders() { return [...this.responseHeaders].map(([k, v]) => k + ': ' + v).join('\r\n'); }
  overrideMimeType(value) { this.mime = value; }
  abort() { this.controller?.abort(); }
  async send(body = null) {
    this.controller = new AbortController();
    const controller = this.controller;
    let expired = false;
    const timer = this.timeout > 0 ? setTimeout(() => { expired = true; controller.abort(); }, this.timeout) : null;
    this.event('loadstart');
    try {
      const response = await fetch(this.url, { method: this.method, headers: this.headers, body, signal: controller.signal });
      this.status = response.status; this.statusText = response.statusText; this.responseURL = response.url; this.responseHeaders = response.headers; this.state(2); this.state(3);
      if (this.responseType === 'arraybuffer') this.response = await response.arrayBuffer();
      else if (this.responseType === 'blob') this.response = await response.blob();
      else {
        this.responseText = await response.text();
        this.response = this.responseType === 'json' ? JSON.parse(this.responseText) : this.responseType === 'document' ? new DOMParser().parseFromString(this.responseText, 'text/html') : this.responseText;
        if (this.responseType === 'document') this.responseXML = this.response;
      }
      this.state(4); this.event('load');
    } catch { this.status = 0; this.state(4); this.event(expired ? 'timeout' : controller.signal.aborted ? 'abort' : 'error'); }
    finally { clearTimeout(timer); this.event('loadend'); }
  }
}
for (const [key, value] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) { ProxyXHR[key] = value; ProxyXHR.prototype[key] = value; }
window.XMLHttpRequest = ProxyXHR;

document.addEventListener('click', event => {
  const anchor = event.target.closest?.('a[href], area[href]');
  if (!anchor) return;
  event.preventDefault();
  try {
    const url = new URL(anchor.getAttribute('href'), currentAddress);
    if (url.href.split('#')[0] === currentAddress.split('#')[0] && url.hash) {
      document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView(); return;
    }
    void navigate(url.href).catch(error => console.error(error.message));
  } catch (error) { console.warn(error.message); }
}, true);
async function submit(form, submitter) {
  const data = new FormData(form, submitter);
  const url = new URL(form.getAttribute('action') || currentAddress, base);
  const method = (form.getAttribute('method') || 'GET').toUpperCase();
  if (method === 'GET') {
    for (const [key, value] of data) url.searchParams.append(key, typeof value === 'string' ? value : value.name);
    return navigate(url.href);
  }
  const multipart = form.enctype === 'multipart/form-data';
  const body = multipart ? data : new URLSearchParams([...data].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]));
  const encoded = new Request(url, { method: 'POST', body });
  return navigate(url.href, { method: 'POST', body: await encoded.arrayBuffer(), headers: [...encoded.headers] });
}
document.addEventListener('submit', event => { event.preventDefault(); void submit(event.target, event.submitter).catch(error => console.error(error.message)); }, true);
HTMLFormElement.prototype.submit = function () { void submit(this).catch(error => console.error(error.message)); };
window.open = url => { void navigate(String(url)).catch(error => console.error(error.message)); return null; };
for (const method of ['pushState', 'replaceState']) history[method] = (_state, _title, url) => {
  if (url != null) { currentAddress = httpUrl(String(url), currentAddress); emit('page', { url: currentAddress, title: document.title }); }
};

// Delay dynamic resources until a blob fetched through the host is available.
const rewrites = new WeakMap();
function resourceAttribute(node, attr, value) {
  if (typeof value !== 'string' || !value.trim() || /^(?:blob:|data:|#)/i.test(value)) {
    rewrites.delete(node);
    return false;
  }
  const tag = node.localName;
  const kind = tag === 'script' && attr === 'src' ? 'script' : tag === 'link' && attr === 'href' ? 'css' : ['img', 'audio', 'video', 'source', 'track', 'input'].includes(tag) && ['src', 'poster'].includes(attr) ? 'asset' : null;
  if (!kind) return false;
  const revision = Symbol(); rewrites.set(node, revision);
  if (tag === 'script' && node.type === 'module') { console.warn('ES modules are unsupported in single-file proxy mode.'); return true; }
  request('asset', { url: httpUrl(value, base), kind }).then(url => {
    if (rewrites.get(node) === revision) nativeSet.call(node, attr, url);
  }).catch(error => { console.warn(error.message); node.dispatchEvent(new Event('error')); });
  return true;
}
Element.prototype.setAttribute = function (name, value) {
  if (!resourceAttribute(this, String(name).toLowerCase(), String(value))) return nativeSet.call(this, name, value);
};
for (const [Constructor, property] of [[HTMLScriptElement, 'src'], [HTMLImageElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLLinkElement, 'href'], [HTMLVideoElement, 'poster']]) {
  const descriptor = Object.getOwnPropertyDescriptor(Constructor.prototype, property);
  if (descriptor?.set) Object.defineProperty(Constructor.prototype, property, { ...descriptor, set(value) { if (!resourceAttribute(this, property, String(value))) descriptor.set.call(this, value); } });
}
const observer = new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node.nodeType !== 1) continue;
    for (const element of [node, ...node.querySelectorAll('[src],link[href]')]) {
      for (const attr of ['src', 'poster', 'href']) if (element.hasAttribute(attr)) resourceAttribute(element, attr, element.getAttribute(attr));
    }
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

const nodes = new Map(); const ids = new WeakMap(); let nextNode = 0;
function nodeId(node) {
  if (!node || node.nodeType !== 1) throw new Error('Select an element.');
  if (!ids.has(node)) { if (nodes.size >= 5000) throw new Error('Inspector limit reached.'); ids.set(node, String(++nextNode)); nodes.set(ids.get(node), node); }
  return ids.get(node);
}
function tree() {
  const root = document.documentElement, queue = [root], result = [];
  while (queue.length && result.length < 800) {
    const node = queue.shift();
    const children = [...node.children].slice(0, Math.max(0, Math.min(250, 800 - result.length - queue.length - 1)));
    result.push({ id: nodeId(node), localName: node.localName, elementId: node.id, className: typeof node.className === 'string' ? node.className : '', children: children.map(nodeId) });
    queue.push(...children);
  }
  return { rootId: nodeId(root), nodes: result };
}
function selected(params) {
  const node = params.selector ? document.querySelector(params.selector) : nodes.get(String(params.id));
  if (!node) throw new Error('Element not found.'); return node;
}
function selection(node) { return { id: nodeId(node), info: runtime.describe(node), tree: tree() }; }
async function command(method, params) {
  if (!runtime) throw new Error('Page tools are starting.');
  switch (method) {
    case 'evaluate': if (typeof params.code !== 'string' || params.code.length > 110000) throw new Error('Script too large.'); return formatValue(await runtime.evaluate(params.code));
    case 'tree': return tree();
    case 'describe': return runtime.describe(selected(params));
    case 'select': { const node = selected(params); runtime.select(node); return selection(node); }
    case 'style': { const node = selected(params); runtime.setStyle(node, params.property, params.value); return runtime.describe(node); }
    case 'edit': return selection(runtime.editNode(selected(params), params));
    case 'undo': return selection(runtime.undo());
    case 'pick': if (params.active) runtime.startPicking(); else runtime.stopPicking(); return null;
    default: throw new Error('Unsupported tool command.');
  }
}
function startTools() {
  runtime = attachRuntime(window, {
    onConsole: entry => emit('console', { ...entry, args: entry.args.map(value => formatValue(value)) }),
    onSelect: node => emit('select', selection(node)), onPickEnd: () => emit('pickEnd', {}),
    onNavigate: () => emit('pagehide', {}),
  });
  emit('page', { url: currentAddress, title: document.title });
}
window.addEventListener('message', function initialize(event) {
  if (event.source !== parent || event.data?.type !== 'mochii:singlefile:port' || event.data.token !== token || !event.ports[0] || port) return;
  port = event.ports[0];
  window.removeEventListener('message', initialize);
  port.onmessage = async ({ data }) => {
    if (Number.isSafeInteger(data.response)) {
      const task = pending.get(data.response);
      if (task) { pending.delete(data.response); clearTimeout(task.timer); data.error ? task.reject(new Error(data.error)) : task.resolve(data.result); }
    } else if (Number.isSafeInteger(data.id)) {
      try { port.postMessage({ id: data.id, result: await command(data.method, data.params || {}) }); }
      catch (error) { port.postMessage({ id: data.id, error: String(error.message).slice(0, 1000) }); }
    }
  };
  port.start();
  for (const data of waiting.splice(0)) port.postMessage(data);
}, false);
parent.postMessage({ type: 'mochii:singlefile:ready', token }, '*');
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startTools, { once: true }); else startTools();
