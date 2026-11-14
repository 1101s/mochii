export const MAX_BODY = 32 * 1024 * 1024;
export const MAX_PAGE = 96 * 1024 * 1024;

export function httpUrl(value, base) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid address.');
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) address without login details.');
  return url.href;
}

export function requestHeaders(input = {}) {
  const result = {};
  for (const [name, value] of new Headers(input)) {
    // Never forward browser credentials or transport/framing headers.
    if (/^(?:cookie|authorization|proxy-.*|host|connection|content-length|origin|referer|sec-.*)$/i.test(name)) continue;
    result[name] = value;
  }
  return result;
}

export async function readLimited(body, limit = MAX_BODY) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Response exceeds the single-file size limit (32 MiB per resource).');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function responseHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw || {})) {
    if (/^(?:set-cookie|content-encoding|content-length|transfer-encoding)$/i.test(name)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }
  return headers;
}
