import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DOMParser, parseHTML } from 'linkedom';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { httpUrl, readLimited, requestHeaders, responseHeaders } from '../protocol.js';

const result = await build({ entryPoints: [new URL('../rewrite.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'child-fixture', setup(b) { b.onResolve({ filter: /^singlefile:child$/ }, () => ({ path: 'child', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default "/* child bridge */";' })); } }],
});
const { PageResources, PAGE_CSP } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('URL validation resolves relative paths and rejects credentials and active schemes', () => {
  assert.equal(httpUrl('../b?q=1', 'https://example.org/a/c'), 'https://example.org/b?q=1');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.org', 'data:text/html,x']) assert.throws(() => httpUrl(url));
});
test('request and response headers never carry browser cookies or stale framing', () => {
  assert.deepEqual(requestHeaders({ Cookie: 'secret', Authorization: 'secret', Host: 'private', 'Sec-Fetch-Site': 'none', Accept: 'text/html' }), { accept: 'text/html' });
  const headers = responseHeaders({ 'Set-Cookie': ['session=1', 'other=2'], 'Content-Encoding': 'gzip', 'Content-Length': '400', 'Content-Type': 'text/html' });
  assert.equal(headers.get('set-cookie'), null); assert.equal(headers.get('content-encoding'), null); assert.equal(headers.get('content-type'), 'text/html');
});
test('bounded reads cancel oversized streams and retain valid bytes', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
  await assert.rejects(readLimited(stream, 4), /size limit/); assert.equal(cancelled, true);
  assert.deepEqual(await readLimited(new Response('abc').body, 3), new TextEncoder().encode('abc'));
});

function resources(routes) {
  const fetched = [], blobs = new Map(), revoked = [];
  const controller = new AbortController();
  const instance = new PageResources({ async fetch(url) {
    fetched.push(url);
    assert.ok(routes[url], 'Unexpected route: ' + url);
    const response = new Response(routes[url][0], { headers: { 'content-type': routes[url][1] } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  } }, controller.signal, { parser: () => new DOMParser(), createURL(blob) { const url = 'blob:fixture/' + blobs.size; blobs.set(url, blob); return url; }, revokeURL: url => revoked.push(url) });
  return { instance, controller, fetched, blobs, revoked };
}
test('HTML rewriting embeds scripts/styles/images and isolates remote content', async () => {
  const { instance, fetched, blobs, revoked } = resources({
    'https://site.test/assets/style.css': ['body{background:url(bg.png)}', 'text/css'],
    'https://site.test/assets/bg.png': ['image', 'image/png'],
    'https://site.test/assets/logo.png': ['logo', 'image/png'],
    'https://site.test/assets/run.js': ['document.body.dataset.ran="yes"', 'application/javascript'],
  });
  const html = await instance.document('<html><head><base href="/assets/"><meta http-equiv="refresh" content="0;url=https://other.test"><link rel="stylesheet" href="style.css"><script src="run.js" integrity="x"></script><script type="module">import "x"</script></head><body><img src="logo.png"><a href="next">Next</a><form action="submit"></form><iframe src="frame"></iframe></body></html>', 'https://site.test/page', 'token');
  const { document } = parseHTML(html);
  assert.equal(document.querySelectorAll('base,iframe,script[type=module],[integrity]').length, 0);
  assert.equal(document.querySelector('meta').getAttribute('content'), PAGE_CSP);
  assert.match(document.querySelector('script[src]').getAttribute('src'), /^blob:/);
  assert.equal(document.querySelector('a').href, 'https://site.test/assets/next');
  assert.equal(document.querySelector('form').getAttribute('action'), 'https://site.test/assets/submit');
  assert.equal(fetched.length, 4); assert.equal(blobs.size, 4);
  assert.ok([...instance.warnings].some(message => /ES module/.test(message)));
  instance.dispose(); assert.equal(revoked.length, 4);
  await assert.rejects(instance.asset('https://site.test/late', 'https://site.test'), /closed/);
});
test('cyclic CSS imports finish and duplicate assets share their request', async () => {
  const { instance, fetched } = resources({
    'https://site.test/a.css': ['@import "b.css";', 'text/css'],
    'https://site.test/b.css': ['@import "a.css";', 'text/css'],
  });
  const [a, b] = await Promise.all([instance.asset('a.css', 'https://site.test', 'css'), instance.asset('a.css', 'https://site.test', 'css')]);
  assert.equal(a, b); assert.equal(fetched.length, 2);
});
test('aborted page cannot publish additional resource URLs', async () => {
  const { instance, controller } = resources({}); controller.abort();
  assert.throws(() => instance.blob('x', 'text/plain'), { name: 'AbortError' });
});
test('default resources are data URLs usable in an opaque iframe', () => {
  const instance = new PageResources({}, new AbortController().signal);
  const url = instance.blob('hello ✓', 'text/plain');
  assert.equal(url, 'data:text/plain;base64,' + Buffer.from('hello ✓').toString('base64'));
});
test('independently linked cyclic stylesheets cannot deadlock each other', async () => {
  const { instance } = resources({
    'https://site.test/a.css': ['@import "b.css";', 'text/css'],
    'https://site.test/b.css': ['@import "a.css";', 'text/css'],
  });
  const values = await Promise.all([instance.asset('a.css', 'https://site.test', 'css'), instance.asset('b.css', 'https://site.test', 'css')]);
  assert.equal(values.length, 2);
});
test('release HTML has no external script/style entry points and parses all classic scripts', async () => {
  const html = await readFile(new URL('../../mochii-singlefile.html', import.meta.url), 'utf8');
  const { document } = parseHTML(html);
  assert.equal(document.querySelectorAll('script[src],link[rel=stylesheet]').length, 0);
  assert.ok(Buffer.byteLength(html) < 19 * 1024 * 1024);
  for (const [index, script] of [...document.querySelectorAll('script')].entries()) new Script(script.textContent, { filename: 'bundle-script-' + index });
  assert.ok(html.includes('Single-file mode'));
});
