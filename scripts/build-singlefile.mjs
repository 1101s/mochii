import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, '.cache/singlefile');
await mkdir(cache, { recursive: true });
const assets = new Map();
const manifests = new Map();
const escapeScript = text => text.replace(/<\/script/gi, '<\\/script');
const pathFor = (value, file) => resolve(root, new URL(value, 'https://bundle.invalid/' + file).pathname.slice(1));
const plugins = [{ name: 'singlefile-assets', setup(builder) {
  builder.onResolve({ filter: /^singlefile:/ }, args => ({ path: args.path, namespace: 'embedded' }));
  builder.onLoad({ filter: /.*/, namespace: 'embedded' }, args => {
    if (!assets.has(args.path)) throw new Error('Missing build asset: ' + args.path);
    return { contents: `export default ${JSON.stringify(assets.get(args.path))}`, loader: 'js' };
  });
  builder.onResolve({ filter: /^\/(?:browser-tools|apps)\// }, args => ({ path: resolve(root, '.' + args.path) }));
} }];
async function bundle(entry, source) {
  const result = await build({ ...(source ? { stdin: { contents: source, resolveDir: root, sourcefile: entry } } : { entryPoints: [resolve(root, entry)] }),
    bundle: true, write: false, platform: 'browser', format: 'iife', target: ['chrome110', 'firefox115'], minify: true,
    legalComments: 'inline', plugins, logLevel: 'silent', define: { 'import.meta.url': '"about:blank"' },
  });
  return result.outputFiles[0].text;
}
async function download(url, integrity) {
  const key = createHash('sha256').update(url).digest('hex');
  const path = resolve(cache, key);
  let bytes;
  try { bytes = await readFile(path); }
  catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Asset HTTP ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  if (integrity) {
    const [algorithm, expected] = integrity.split('-');
    if (!['sha256', 'sha384', 'sha512'].includes(algorithm) || createHash(algorithm).update(bytes).digest('base64') !== expected) throw new Error('Integrity mismatch: ' + url);
  }
  manifests.set(url, { url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  return bytes;
}
function mime(url) {
  const path = new URL(url).pathname;
  return path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.woff') ? 'font/woff' : path.endsWith('.ttf') ? 'font/ttf' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'application/octet-stream';
}
async function css(source, base) {
  const matches = [...source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)];
  for (const match of matches.reverse()) {
    const value = match[1] ?? match[2] ?? match[3];
    if (!value || /^(?:data:|#)/i.test(value)) continue;
    const url = new URL(value, base).href;
    const bytes = await download(url);
    source = source.slice(0, match.index) + `url("data:${mime(url)};base64,${bytes.toString('base64')}")` + source.slice(match.index + match[0].length);
  }
  return source;
}
async function documentBundle(file, main = false) {
  const { document } = parseHTML(await readFile(resolve(root, file), 'utf8'));
  const modules = [];
  for (const link of document.querySelectorAll('link')) {
    if (link.getAttribute('rel') !== 'stylesheet') { link.remove(); continue; }
    const href = link.getAttribute('href');
    const remote = /^https?:/.test(href);
    const source = remote ? (await download(href)).toString('utf8') : await readFile(pathFor(href, file), 'utf8');
    const style = document.createElement('style');
    style.textContent = remote ? await css(source, href) : source;
    link.replaceWith(style);
  }
  for (const script of document.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    if (src && script.getAttribute('type') === 'module') {
      // Mirror telemetry has no meaning for a portable document.
      if (!src.endsWith('/mirror-report.js')) modules.push(pathFor(src, file));
      script.remove(); continue;
    }
    if (src) {
      script.textContent = escapeScript(/^https?:/.test(src) ? (await download(src, script.getAttribute('integrity'))).toString('utf8') : await readFile(pathFor(src, file), 'utf8'));
      for (const attr of ['src', 'integrity', 'crossorigin', 'defer', 'async']) script.removeAttribute(attr);
    } else if (main) {
      script.textContent = script.textContent.replace("import('/browser-tools/music-catalog.js')", 'Promise.resolve(globalThis.MochiiSinglefileMusic)');
    }
  }
  const imports = modules.map(path => `import ${JSON.stringify(path.replaceAll('\\', '/'))};`).join('\n');
  if (!main) {
    const bridge = document.createElement('script');
    bridge.textContent = 'globalThis.MochiiSinglefile=parent.MochiiSinglefile;';
    document.head.prepend(bridge);
  }
  const entry = (main ? 'import "./singlefile/host.js";\nimport * as music from "./browser-tools/music-catalog.js";\nglobalThis.MochiiSinglefileMusic=music;\n' : '') + imports;
  const script = document.createElement('script'); script.textContent = escapeScript(await bundle(file + '.entry.js', entry)); document.body.append(script);
  if (main) {
    const notice = document.createElement('p'); notice.className = 'singlefile-note';
    notice.textContent = 'Single-file mode · Wisp connection required · Some websites are incompatible';
    document.querySelector('.hero-content').append(notice);
    const style = document.createElement('style'); style.textContent = '.singlefile-note{font:12px system-ui;color:#aaa;text-align:center;max-width:32rem;line-height:1.6;margin:20px auto}'; document.head.append(style);
  }
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}

assets.set('singlefile:worker', await bundle('singlefile/transport-worker.js'));
assets.set('singlefile:child', await bundle('singlefile/child.js'));
const apps = {};
for (const path of ['apps/auk.html', 'apps/vox.html', 'apps/desktop.html', 'apps/mochii-cloud.html']) apps['/' + path] = await documentBundle(path);
assets.set('singlefile:apps', apps);
let html = await documentBundle('math.html', true);
const license = await readFile(resolve(root, 'LICENSE'), 'utf8');
const epoxyLicense = await readFile(resolve(root, 'licenses/EPOXY-LICENSE.txt'), 'utf8');
html = html.replace('<head>', '<head>\n<!-- Mochii single-file build. Source and third-party notices: https://github.com/1101s/mochii/blob/main/docs/SINGLEFILE.md -->\n');
html = html.replace('</body>', `<details style="position:fixed;bottom:4px;left:8px;z-index:10;max-width:90vw;background:#151515;color:#aaa;font:11px system-ui"><summary>Licenses & source</summary><div style="max-height:60vh;overflow:auto;padding:12px"><a href="https://github.com/1101s/mochii" target="_blank" rel="noopener noreferrer">Complete application source</a><pre style="white-space:pre-wrap">${(license + '\n\nEpoxy Transport — AGPL-3.0-only\n' + epoxyLicense).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre></div></details></body>`);
if (Buffer.byteLength(html) > 19 * 1024 * 1024) throw new Error('Single-file artifact exceeds the 19 MiB publishing budget.');
await writeFile(resolve(root, 'mochii-singlefile.html'), html);
await writeFile(resolve(root, 'singlefile/assets-manifest.json'), JSON.stringify([...manifests.values()].sort((a, b) => a.url.localeCompare(b.url)), null, 2) + '\n');
console.log(`Single-file build: ${Buffer.byteLength(html)} bytes; ${Object.keys(apps).length} embedded apps; ${manifests.size} bundled CDN assets.`);
