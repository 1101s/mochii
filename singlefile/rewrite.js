import { httpUrl, MAX_PAGE } from './protocol.js';
import childSource from 'singlefile:child';

const decoder = new TextDecoder();
const escapeScript = text => text.replace(/<\/script/gi, '<\\/script');
export const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; media-src blob: data:; font-src blob: data:; connect-src 'none'; frame-src blob: data: about:; worker-src blob:; form-action 'none'; base-uri 'none'";

function dataURL(content, type) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return `data:${type};base64,${btoa(binary)}`;
}

export class PageResources {
  constructor(transport, signal, { parser = () => new DOMParser(), createURL = null, revokeURL = url => URL.revokeObjectURL(url) } = {}) {
    Object.assign(this, { transport, signal, parser, createURL, revokeURL });
    this.urls = new Set(); this.cache = new Map(); this.bytes = 0; this.disposed = false;
    this.warnings = new Set();
  }
  check() {
    this.signal?.throwIfAborted();
    if (this.disposed) throw new DOMException('Page closed', 'AbortError');
  }
  blob(content, type) {
    this.check();
    const blob = new Blob([content], { type });
    this.bytes += blob.size;
    if (this.bytes > MAX_PAGE) throw new Error('This page exceeds the 96 MiB resource budget.');
    // Parent-origin blob URLs cannot be dereferenced by an opaque sandbox in
    // every browser. Data URLs carry fetched bytes without granting origin access.
    if (!this.createURL) return dataURL(content, type);
    const url = this.createURL(blob); this.urls.add(url); return url;
  }
  async fetch(url, options = {}) {
    this.check();
    const response = await this.transport.fetch(httpUrl(url), { ...options, signal: this.signal });
    this.check();
    return response;
  }
  async asset(value, base, kind = 'asset', ancestors = []) {
    if (/^(?:data:|blob:|#)/i.test(value)) return value;
    const url = httpUrl(value, base);
    if (ancestors.includes(url) || ancestors.length >= 6) return '';
    const key = kind + ':' + url + (kind === 'css' ? ':' + ancestors.join('|') : '');
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.cache.size >= 500) throw new Error('This page exceeds the 500-resource limit.');
    const task = (async () => {
      const response = await this.fetch(url);
      if (!response.ok) throw new Error(`Resource returned HTTP ${response.status}: ${url}`);
      const type = response.headers.get('content-type') || 'application/octet-stream';
      if (kind === 'css') return this.blob(await this.css(await response.text(), response.url || url, [...ancestors, url]), 'text/css');
      return this.blob(await response.arrayBuffer(), kind === 'script' ? 'text/javascript' : type);
    })();
    this.cache.set(key, task);
    return task;
  }
  async css(text, base, ancestors = []) {
    // URL tokens and @import strings are rewritten; CSS escapes in URLs are a
    // documented compatibility limit. A cycle is cut before awaiting its cache.
    const tokens = /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"\n]*)"|'([^'\n]*)')/gi;
    const matches = [...text.matchAll(tokens)];
    const replacements = await Promise.all(matches.map(async match => {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
      const isImport = match[4] !== undefined || match[5] !== undefined || /@import\s*$/i.test(text.slice(Math.max(0, match.index - 20), match.index));
      try {
        const url = await this.asset(value, base, isImport ? 'css' : 'asset', ancestors);
        return (match[4] !== undefined || match[5] !== undefined ? '@import ' : '') + `url(${JSON.stringify(url)})`;
      } catch (error) { this.check(); this.warnings.add(error.message); return isImport ? 'url("")' : 'url("data:,")'; }
    }));
    for (let i = matches.length - 1; i >= 0; i--) text = text.slice(0, matches[i].index) + replacements[i] + text.slice(matches[i].index + matches[i][0].length);
    return text;
  }
  async document(text, address, token) {
    const doc = this.parser().parseFromString(text, 'text/html');
    let base = address;
    try { if (doc.querySelector('base[href]')) base = httpUrl(doc.querySelector('base[href]').getAttribute('href'), address); } catch {}
    for (const node of doc.querySelectorAll('base, meta[http-equiv]')) node.remove();
    for (const node of doc.querySelectorAll('[integrity], [crossorigin], [nonce]')) {
      node.removeAttribute('integrity'); node.removeAttribute('crossorigin'); node.removeAttribute('nonce');
    }
    const tasks = [];
    const rewrite = (node, attr, kind) => {
      const value = node.getAttribute(attr);
      if (!value) return;
      node.removeAttribute(attr);
      tasks.push(this.asset(value, base, kind).then(url => node.setAttribute(attr, url)).catch(error => { this.check(); this.warnings.add(error.message); }));
    };
    for (const node of doc.querySelectorAll('script')) {
      if (node.getAttribute('type') === 'module' || node.getAttribute('type') === 'importmap') {
        node.remove(); this.warnings.add('ES module scripts are not supported by the single-file proxy.'); continue;
      }
      rewrite(node, 'src', 'script');
    }
    for (const node of doc.querySelectorAll('link')) {
      if ((node.getAttribute('rel') || '').toLowerCase() === 'stylesheet') rewrite(node, 'href', 'css');
      else node.remove();
    }
    for (const node of doc.querySelectorAll('style')) tasks.push(this.css(node.textContent, base).then(css => { node.textContent = css; }));
    for (const node of doc.querySelectorAll('[style]')) tasks.push(this.css(node.getAttribute('style'), base).then(css => node.setAttribute('style', css)));
    for (const node of doc.querySelectorAll('img, audio, video, source, track, input[type="image"]')) {
      const hadSource = node.hasAttribute('src');
      rewrite(node, 'src', 'asset'); rewrite(node, 'poster', 'asset');
      // srcset parsing is not comma splitting: data URLs themselves contain commas.
      // Prefer src, or the first ordinary candidate, in this compatibility mode.
      const srcset = node.getAttribute('srcset');
      if (!hadSource && srcset && !srcset.trim().startsWith('data:')) {
        node.setAttribute('src', srcset.trim().split(/[\s,]/)[0]); rewrite(node, 'src', 'asset');
      }
      node.removeAttribute('srcset');
    }
    for (const node of doc.querySelectorAll('iframe, frame, object, embed')) {
      const value = node.getAttribute('src') || node.getAttribute('data');
      const link = doc.createElement('a'); link.textContent = 'Open embedded page';
      try { link.setAttribute('href', httpUrl(value, base)); } catch { link.removeAttribute('href'); }
      node.replaceWith(link);
      this.warnings.add('Embedded pages open as a new proxy navigation.');
    }
    for (const node of doc.querySelectorAll('a[href], area[href], form[action]')) {
      const attr = node.localName === 'form' ? 'action' : 'href';
      try { node.setAttribute(attr, httpUrl(node.getAttribute(attr), base)); } catch { node.removeAttribute(attr); }
      node.removeAttribute('target'); node.removeAttribute('ping');
    }
    await Promise.all(tasks);
    this.check();
    const csp = doc.createElement('meta'); csp.setAttribute('http-equiv', 'Content-Security-Policy'); csp.setAttribute('content', PAGE_CSP);
    const script = doc.createElement('script');
    script.textContent = escapeScript(`globalThis.__mochiiPage=${JSON.stringify({ address, base, token }).replace(/</g, '\\u003c')};\n${childSource}`);
    doc.head.prepend(script); doc.head.prepend(csp);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }
  dispose() {
    this.disposed = true;
    for (const url of this.urls) this.revokeURL(url);
    this.urls.clear(); this.cache.clear();
  }
}
