import EpoxyTransport from '@mercuryworkshop/epoxy-transport';
import { createProxyNetwork } from '../browser-tools/proxy-network.js';
import { httpUrl, requestHeaders, responseHeaders, readLimited, MAX_BODY } from './protocol.js';

// Epoxy normalizes bodies with new Request("", ...). A blob worker has no
// hierarchical base URL, so that otherwise-valid operation throws. This URL
// is only a body-conversion base; it is never fetched.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input, options) { super(input === '' ? 'https://mochii.invalid/' : input, options); }
};

let transport, network, starting;
const active = new Set();

async function connect(endpoints) {
  if (!network) {
    if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > 32) throw new Error('No Wisp relays configured.');
    network = createProxyNetwork({ endpoints,
      activate: async endpoint => {
        const next = new EpoxyTransport({ wisp: endpoint });
        await next.init();
        transport = next;
      },
      onStatus: data => postMessage({ event: 'network', data }),
    });
  }
  starting ||= network.connect().finally(() => { starting = null; });
  await starting;
}

async function fetchRemote(data) {
  await connect(data.endpoints);
  let url = httpUrl(data.url);
  let method = String(data.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new Error('Unsupported request method.');
  let body = data.body ? new Uint8Array(data.body) : null;
  if (body && body.byteLength > 4 * 1024 * 1024) throw new Error('Uploads are limited to 4 MiB.');
  const headers = requestHeaders(data.headers);
  for (let hop = 0; hop <= 8; hop++) {
    const response = await transport.request(new URL(url), method, body, headers);
    const cleaned = responseHeaders(response.headers);
    const location = cleaned.get('location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel().catch(() => {});
      if (hop === 8) throw new Error('Too many redirects.');
      url = httpUrl(location, url);
      if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
        method = 'GET'; body = null; delete headers['content-type'];
      }
      continue;
    }
    const bytes = await readLimited(response.body, MAX_BODY);
    return { url, status: response.status, statusText: response.statusText, headers: [...cleaned], body: bytes.buffer };
  }
}

onmessage = async ({ data }) => {
  if (!data || !Number.isSafeInteger(data.id)) return;
  if (active.size >= 12) { postMessage({ id: data.id, error: 'Too many active proxy requests.' }); return; }
  active.add(data.id);
  try {
    let result;
    if (data.method === 'switchRelay') {
      await connect(data.endpoints);
      await network.switchEndpoint();
      result = { switched: true };
    } else result = await fetchRemote(data);
    postMessage({ id: data.id, result }, result.body ? [result.body] : []);
  } catch (error) { postMessage({ id: data.id, error: String(error.message || error).slice(0, 1000) }); }
  finally { active.delete(data.id); }
};
