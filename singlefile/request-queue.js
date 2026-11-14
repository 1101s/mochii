// Keep page bursts below the host's concurrency limit. Timeouts belong to the
// dispatched operation, so queued textures do not expire before they start.
export function createRequestQueue(concurrency = 24, capacity = 512) {
  let active = 0;
  const queue = [];
  function pump() {
    while (active < concurrency && queue.length) {
      const { run, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }
  return run => {
    if (queue.length >= capacity) return Promise.reject(new Error('Page request queue is full.'));
    return new Promise((resolve, reject) => { queue.push({ run, resolve, reject }); pump(); });
  };
}
