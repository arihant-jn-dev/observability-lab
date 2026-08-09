/**
 * PATHOLOGY: memLeak  —  the metric that lies to you
 *
 *   docker compose run --rm k6 run /scripts/08-memleak.js
 *
 * Timeline: 45s healthy -> 120s OFF-HEAP leak -> 30s heal -> 120s ON-HEAP leak
 *
 * THE POINT: this is the clearest demonstration in the lab of a metric that is
 * technically correct and completely misleading.
 *
 * Node `Buffer`s are allocated OUTSIDE the V8 heap. So:
 *
 *   PHASE 1, mode="buffer"   (measured in this lab, real numbers)
 *     container memory   162 MB -> 344 MB     climbing toward the 512M limit
 *     v8js heap used     FLAT                 completely unmoved
 *     -> A dashboard built on heapUsed -- which is what most Node dashboards
 *        show -- reports a perfectly healthy process the entire time, right up
 *        until the OOM killer fires. No alert. No warning. Just a restart, and
 *        a "memory leak" you cannot find because your graph says there isn't one.
 *
 *   PHASE 2, mode="heap"
 *     container memory   climbs
 *     v8js heap used     climbs too
 *     -> The case everyone pictures, and the only one heap metrics catch.
 *
 * WATCH: USE dashboard, "Memory by container" next to "V8 heap used".
 * Same word, "leak"; one of these panels sees both phases and the other sees
 * only half.
 *
 * WHY IT MATTERS BEYOND NODE: every runtime has memory it does not account for
 * in its own "heap" number -- JVM off-heap/direct buffers, Go cgo allocations,
 * Python C extensions. The generalisable rule: measure memory at the boundary
 * that KILLS you (the container limit), not at the boundary your runtime finds
 * convenient to report.
 *
 * ALSO: the ContainerNearMemoryLimit alert (85% of limit) fires off container
 * memory, so it catches BOTH phases. That is not luck -- it is why the alert
 * was written against the container limit rather than against heap.
 */
import { sleep } from 'k6';
import { getProducts, setPathology, heal } from './lib.js';

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: 12, duration: '5m30s', exec: 'load' },
    controller: {
      executor: 'shared-iterations',
      vus: 1, iterations: 1, exec: 'controller', maxDuration: '5m30s',
    },
  },
};

export function load() {
  getProducts(10);
  sleep(0.1);
}

export function controller() {
  heal();
  console.log('[0:00] baseline');
  sleep(45);

  console.log('[0:45] >>> PHASE 1 — memLeak mode=buffer (OFF-heap) <<<');
  console.log('        container memory climbs; V8 heap DOES NOT MOVE');
  setPathology({ memLeak: { enabled: true, kbPerRequest: 2048, mode: 'buffer' } });
  sleep(120);

  console.log('[2:45] healing — watch memory drop back');
  heal();
  sleep(30);

  console.log('[3:15] >>> PHASE 2 — memLeak mode=heap (ON-heap) <<<');
  console.log('        now BOTH climb together');
  setPathology({ memLeak: { enabled: true, kbPerRequest: 2048, mode: 'heap' } });
  sleep(120);

  console.log('[5:15] healing');
  heal();
}

export function teardown() {
  heal();
}
