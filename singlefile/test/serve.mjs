// Local-only preview, including an SVG document.write path matching the CDN loader.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connect } from 'node:net';
import { WebSocketServer } from 'ws';
const root = resolve(import.meta.dirname, '../..');
const server = createServer(async (request, response) => {
  try {
    const incoming = new URL(request.url, 'http://localhost');
    const path = incoming.pathname;
    if (path.startsWith('/fixture/')) {
      const routes = {
        '/fixture/page': ['text/html', '<!doctype html><html><head><title>Proxy fixture</title><link rel="stylesheet" href="/fixture/style.css"><script defer src="/fixture/script.js"></script></head><body><h1>Proxy fixture</h1><p id="script">script pending</p><p id="fetch">fetch pending</p><p id="xhr">xhr pending</p><p id="dynamic">dynamic pending</p><p id="sandbox">sandbox pending</p><img alt="Fixture image" src="/fixture/image.svg"><a href="/fixture/next">Follow relative link</a><form method="post" action="/fixture/post"><label>Message<input name="message" value="fixture-value"></label><button>Submit fixture</button></form></body></html>'],
        '/fixture/style.css': ['text/css', 'body{background:#123;color:#fff;font:18px system-ui;padding:24px}h1{color:#8f8}img{width:24px;height:24px}'],
        '/fixture/image.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="lime"/></svg>'],
        '/fixture/script.js': ['text/javascript', 'document.getElementById("script").textContent="classic script passed"; fetch("/fixture/json").then(r=>r.json()).then(d=>document.getElementById("fetch").textContent="fetch "+d.value); const xhr=new XMLHttpRequest();xhr.open("GET","/fixture/json");xhr.onload=()=>document.getElementById("xhr").textContent="xhr "+JSON.parse(xhr.responseText).value;xhr.send();const script=document.createElement("script");script.src="/fixture/dynamic.js";document.body.append(script);try{parent.document.body;document.getElementById("sandbox").textContent="sandbox FAILED"}catch{document.getElementById("sandbox").textContent="sandbox passed"}'],
        '/fixture/dynamic.js': ['text/javascript', 'document.getElementById("dynamic").textContent="dynamic script passed"'],
        '/fixture/json': ['application/json', '{"value":"passed"}'],
        '/fixture/next': ['text/html', '<!doctype html><title>Navigation passed</title><h1>Relative navigation passed</h1>'],
      };
      if (path === '/fixture/post') {
        let body = ''; for await (const chunk of request) body += chunk;
        response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><h1>POST passed</h1><pre>' + body.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</pre>'); return;
      }
      const route = routes[path]; response.writeHead(route ? 200 : 404, { 'content-type': route?.[0] || 'text/plain' }); response.end(route?.[1] || 'missing fixture'); return;
    }
    if (path === '/loader.svg') {
      const svg = (await readFile(resolve(root, 'mochii-loader.svg'), 'utf8')).replace('https://cdn.jsdelivr.net/gh/1101s/mochii@main/mochii-singlefile.html', '/mochii-singlefile.html' + (incoming.searchParams.has('fixture') ? '?fixture=1' : ''));
      response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }); response.end(svg);
    } else if (path === '/mochii-singlefile.html' || path === '/') {
      let html = await readFile(resolve(root, 'mochii-singlefile.html'), 'utf8');
      if (incoming.searchParams.has('fixture')) html = html.replace('</head>', '<script>{const original=MochiiConfig;globalThis.MochiiConfig={...original,staticConfig:(origin)=>({...original.staticConfig(origin),wispEndpoints:[{name:"Local fixture",url:"ws://127.0.0.1:8767/wisp/"}]})};}</script></head>');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html);
    } else { response.writeHead(404); response.end('Not found'); }
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
// A loopback-only Wisp v1 fixture. It can connect only to this test server,
// irrespective of requested destination; it is not an open network proxy.
const relay = new WebSocketServer({ server, path: '/wisp/' });
relay.on('connection', socket => {
  const streams = new Map();
  const packet = (type, id, data = Buffer.alloc(0)) => { const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(id, 1); if (socket.readyState === 1) socket.send(Buffer.concat([header, data])); };
  const credit = Buffer.alloc(4); credit.writeUInt32LE(128); packet(3, 0, credit);
  socket.on('message', bytes => {
    if (bytes.length < 5) return;
    const id = bytes.readUInt32LE(1);
    if (bytes[0] === 1 && bytes.length >= 8) {
      if (bytes[5] !== 1 || bytes.subarray(8).toString() !== 'fixture.mochii.test') { packet(4, id, Buffer.from([2])); return; }
      const stream = connect(8767, '127.0.0.1'); streams.set(id, stream);
      stream.on('data', data => packet(2, id, data));
      stream.on('close', () => { streams.delete(id); packet(4, id, Buffer.from([2])); });
      stream.on('error', () => stream.destroy());
    } else if (bytes[0] === 2) { streams.get(id)?.write(bytes.subarray(5)); packet(3, id, credit); }
    else if (bytes[0] === 4) streams.get(id)?.destroy();
  });
  socket.on('close', () => { for (const stream of streams.values()) stream.destroy(); });
});
server.listen(8767, '127.0.0.1', () => console.log('Mochii preview: http://127.0.0.1:8767/loader.svg'));
