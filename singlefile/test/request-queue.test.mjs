import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestQueue } from '../request-queue.js';
import { hideServiceWorker } from '../sandbox-compat.js';

test('sandbox service worker feature detection reports unavailable without throwing', () => {
  const prototype = Object.defineProperty({}, 'serviceWorker', { configurable: true, get() { throw new Error('SecurityError'); } });
  const navigator = Object.create(prototype);
  hideServiceWorker(navigator);
  assert.equal('serviceWorker' in navigator, false);
  assert.equal(navigator.serviceWorker, undefined);
});

test('texture bursts queue without rejecting assets or exceeding host concurrency', async () => {
  const enqueue = createRequestQueue();
  let active = 0, peak = 0;
  const values = await Promise.all(Array.from({ length: 160 }, (_, index) => enqueue(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--; return index;
  })));
  assert.equal(peak, 24);
  assert.deepEqual(values, Array.from({ length: 160 }, (_, index) => index));
});

test('queue bounds pending work and recovers after a failed resource', async () => {
  const enqueue = createRequestQueue(1, 1);
  let release;
  const first = enqueue(() => new Promise(resolve => { release = resolve; }));
  const second = enqueue(() => { throw new Error('resource failed'); });
  const failure = assert.rejects(second, /resource failed/);
  await assert.rejects(enqueue(() => 3), /queue is full/);
  release(1);
  assert.equal(await first, 1);
  await failure;
  assert.equal(await enqueue(() => 4), 4);
});
