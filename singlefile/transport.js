import workerSource from 'singlefile:worker';
import { httpUrl, requestHeaders } from './protocol.js';

export class Transport {
  constructor(endpoints, onStatus = () => {}) {
    this.endpoints = endpoints;
    this.onStatus = onStatus;
    this.pending = new Map();
    this.queue = [];
    this.nextId = 0;
  }
  ensureWorker() {
    if (this.worker) return;
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    try { this.worker = new Worker(url); }
    finally { URL.revokeObjectURL(url); }
    this.worker.onmessage = ({ data }) => {
      if (data.event === 'network') { this.onStatus(data.data); return; }
      const item = this.pending.get(data.id);
      if (!item) return;
      this.pending.delete(data.id);
      item.finish(data.error ? new Error(data.error) : null, data.result);
      this.pump();
    };
    this.worker.onerror = () => this.reset(new Error('Proxy worker failed. Try another relay or reload.'));
  }
  reset(error = new DOMException('Request cancelled.', 'AbortError')) {
    this.worker?.terminate(); this.worker = null;
    const items = [...this.pending.values(), ...this.queue];
    this.pending.clear(); this.queue = [];
    for (const item of items) item.finish(error);
  }
  pump() {
    while (this.pending.size < 8 && this.queue.length) {
      const item = this.queue.shift();
      try {
        this.ensureWorker();
        this.pending.set(item.id, item);
        this.worker.postMessage({ ...item.data, id: item.id, endpoints: this.endpoints });
      } catch (error) { this.pending.delete(item.id); item.finish(error); }
    }
  }
  request(data, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.queue.length >= 256) return Promise.reject(new Error('This page requested too many resources.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      // Epoxy has no effective per-fetch cancellation. Terminating its dedicated
      // worker closes sockets and bounds abandoned work, including sibling calls.
      const abort = () => this.reset(signal.reason || new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(() => this.reset(new Error('Proxy request timed out. Retry or switch relays.')), 45000);
      const item = { id, data, finish(error, result) {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      } };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(item); this.pump();
    });
  }
  async fetch(url, options = {}) {
    const method = options.method || 'GET';
    const headers = new Headers(options.headers);
    let body = options.body;
    if (body != null && !(body instanceof ArrayBuffer)) {
      const request = new Request(httpUrl(url), { method, headers, body });
      body = await request.arrayBuffer();
      request.headers.forEach((value, name) => headers.set(name, value));
    }
    const result = await this.request({ url: httpUrl(url), method, headers: requestHeaders(headers), body }, options.signal);
    const response = new Response([101, 204, 205, 304].includes(result.status) || method === 'HEAD' ? null : result.body,
      { status: result.status, statusText: result.statusText, headers: result.headers });
    Object.defineProperty(response, 'url', { value: result.url });
    return response;
  }
  switchRelay() { return this.request({ method: 'switchRelay' }); }
}
