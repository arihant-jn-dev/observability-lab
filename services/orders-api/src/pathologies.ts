/**
 * The switchable failure modes. This module is the heart of the lab.
 *
 * Everything here is mutable in-process state, flipped at runtime through
 * /admin/pathologies. No restarts -- because a restart resets the very metrics
 * and memory profile you are trying to observe, and because in production you
 * never get to restart your way to understanding.
 *
 * NOTE: state is per-process. The API and the worker are separate containers,
 * so toggling `slow` on the API does not affect the worker. That is realistic:
 * "the service is slow" is rarely true of every replica at once.
 */

export type PathologyState = {
  /**
   * Inject fixed latency, but only into routes matching `route`.
   * Scoped on purpose: "the service is slow" is never true of every endpoint,
   * and the real skill is finding WHICH one. A global slowdown would let you
   * skip that step, which is the step that matters.
   */
  slow: { enabled: boolean; ms: number; route: string };
  /** Fail a percentage of requests with a 500. Partial failure, not total. */
  errorRate: { enabled: boolean; pct: number };
  /** Block the event loop with real work. Latency WITHOUT a slow dependency. */
  cpuBurn: { enabled: boolean; ms: number };
  /**
   * Retain memory per request, forever. Slow death instead of fast death.
   *
   * `mode` matters more than it looks:
   *   'buffer' -- allocates OFF-heap (Node Buffers live outside the V8 heap).
   *               Container RSS climbs; `heapUsed` stays flat. A dashboard
   *               built on heap metrics shows a perfectly healthy process
   *               right up until the OOM killer fires.
   *   'heap'   -- allocates JS objects on the V8 heap. Both RSS and heapUsed
   *               climb together, which is the case most people picture.
   *
   * Run both and compare. This is the cleanest demonstration in the whole lab
   * of a metric that is technically correct and completely misleading.
   */
  memLeak: { enabled: boolean; kbPerRequest: number; mode: 'buffer' | 'heap' };
  /** Turn one JOIN into 1 + N queries. Each fast; the sum is not. */
  nPlusOne: { enabled: boolean };
  /** Make the outbound payments call crawl. Your latency, someone else's fault. */
  slowDependency: { enabled: boolean; ms: number };
  /** Attach an unbounded label to a metric. Watch Prometheus suffer. */
  cardinalityBomb: { enabled: boolean };
};

const defaults: PathologyState = {
  slow: { enabled: false, ms: 800, route: '/products' },
  errorRate: { enabled: false, pct: 20 },
  cpuBurn: { enabled: false, ms: 250 },
  memLeak: { enabled: false, kbPerRequest: 512, mode: 'buffer' },
  nPlusOne: { enabled: false },
  slowDependency: { enabled: false, ms: 5000 },
  cardinalityBomb: { enabled: false },
};

let state: PathologyState = structuredClone(defaults);

export function getPathologies(): PathologyState {
  return state;
}

/** Shallow-merge per pathology, so you can PATCH just `{"slow":{"ms":2000}}`. */
export function updatePathologies(patch: Partial<PathologyState>): PathologyState {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in state)) continue;
    const k = key as keyof PathologyState;
    state[k] = { ...(state[k] as object), ...(value as object) } as never;
  }
  return state;
}

export function resetPathologies(): PathologyState {
  state = structuredClone(defaults);
  releaseLeak();
  return state;
}

/* ------------------------------------------------------------------ *
 * memLeak
 * ------------------------------------------------------------------ */

// A module-level array is the simplest *genuine* leak: the allocations stay
// reachable from a GC root forever, so no amount of GC pressure reclaims them.
// This is what a real leak looks like -- an unbounded cache, a growing map of
// "recent" things, a listener array nobody removes.
const leakStore: Array<Buffer | object[]> = [];
let leakedBytes = 0;

export function leakMemory(kb: number, mode: 'buffer' | 'heap' = 'buffer'): void {
  if (mode === 'heap') {
    // JS objects on the V8 heap. Roughly ~100 bytes per small object, so we
    // scale the count to approximate the requested size. Both heapUsed and RSS
    // will climb.
    const count = Math.max(1, Math.floor((kb * 1024) / 100));
    const chunk: object[] = new Array(count);
    for (let i = 0; i < count; i++) {
      chunk[i] = { id: i, tag: `leaked-${i}`, at: 0, payload: [1, 2, 3, 4, 5] };
    }
    leakStore.push(chunk);
    leakedBytes += count * 100;
    return;
  }

  // Buffer.alloc (not allocUnsafe) actually writes zeroes, forcing the OS to
  // back the pages with real physical memory. allocUnsafe can be lazily mapped
  // and would understate RSS growth.
  //
  // Buffers are allocated OUTSIDE the V8 heap, so this grows RSS while leaving
  // heapUsed almost unchanged. See the PathologyState comment above.
  const buf = Buffer.alloc(kb * 1024, 1);
  leakStore.push(buf);
  leakedBytes += buf.byteLength;
}

export function leakStats() {
  return {
    chunks: leakStore.length,
    retainedMb: +(leakedBytes / 1024 / 1024).toFixed(2),
  };
}

export function releaseLeak(): { freedChunks: number } {
  const freed = leakStore.length;
  leakStore.length = 0;
  leakedBytes = 0;
  return { freedChunks: freed };
}

/* ------------------------------------------------------------------ *
 * cpuBurn
 * ------------------------------------------------------------------ */

/**
 * Busy-wait doing real math. This blocks the event loop, which is the whole
 * point: in Node, CPU saturation and "slow I/O" look identical from the outside
 * (high response time) but have completely different fixes. Traces tell them
 * apart -- a CPU-bound request has a long span with no child spans inside it.
 */
export function burnCpu(ms: number): number {
  const end = Date.now() + ms;
  let acc = 0;
  while (Date.now() < end) {
    for (let i = 0; i < 1e5; i++) acc += Math.sqrt(i) * Math.sin(i);
  }
  return acc;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function shouldFail(pct: number): boolean {
  return Math.random() * 100 < pct;
}
