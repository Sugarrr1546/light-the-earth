/** Small country-level scheduler: geometry stays resident only while useful. */
export interface BoundaryLoader {
  setTargets: (codes: string[]) => void;
  request: (code: string) => Promise<boolean>;
  /** Unmount every resident country that is not a current target. */
  release: () => string[];
  dispose: () => void;
}
interface LoaderOptions<T> {
  load: (code: string, signal: AbortSignal) => Promise<T>;
  mount: (code: string, data: T) => void;
  unmount: (code: string) => void;
  onError?: (code: string, error: unknown) => void;
  onLoading?: (codes: string[]) => void;
  capacity?: number;
  concurrency?: number;
  retryDelay?: number;
  maxWeight?: number;
  weight?: (data:T)=>number;
}
interface Job {
  code: string;
  controller: AbortController;
  promise: Promise<boolean>;
  settle: (success: boolean) => void;
}

export function prioritizeCountries(candidates: { code: string; distance: number }[], centerCode?: string, limit = 4): string[] {
  const distances = new Map<string, number>();
  for (const { code, distance } of candidates) {
    if (code) distances.set(code, Math.min(distances.get(code) ?? Infinity, Number.isFinite(distance) ? distance : Infinity));
  }
  return [...distances].sort(([a, x], [b, y]) =>
    Number(b === centerCode) - Number(a === centerCode) || x - y || a.localeCompare(b),
  ).slice(0, Math.max(0, limit)).map(([code]) => code);
}

export function createBoundaryLoader<T>(options: LoaderOptions<T>): BoundaryLoader {
  const capacity = Math.max(1, options.capacity ?? 6);
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const retryDelay = options.retryDelay ?? 15_000;
  const resident = new Map<string, number>(); // insertion order is least-recently used first
  const queued = new Map<string, Job>();
  const running = new Set<Job>();
  const failed = new Map<string, number>();
  let targets = new Set<string>();
  let disposed = false;
  const notify = () => options.onLoading?.(disposed ? [] : [...new Set([
    ...[...running].filter(job => !job.controller.signal.aborted).map(job => job.code), ...queued.keys(),
  ])]);
  const touch = (code: string) => { const weight=resident.get(code);if(weight!==undefined){resident.delete(code);resident.set(code,weight);} };
  const active = (code: string) => queued.get(code) ?? [...running].find(job => job.code === code && !job.controller.signal.aborted);
  const cancel = (job: Job) => { job.controller.abort(); job.settle(false); };

  function enqueue(code: string): Job | undefined {
    if (disposed || resident.has(code)) return;
    const current = active(code);
    if (current) return current;
    if (Date.now() - (failed.get(code) ?? -Infinity) < retryDelay) return;
    let settle!: (success: boolean) => void;
    const promise = new Promise<boolean>(resolve => { settle = resolve; });
    const job: Job = { code, controller: new AbortController(), promise, settle };
    queued.set(code, job);
    return job;
  }

  function pump() {
    if (disposed) return;
    while (running.size < concurrency && queued.size) {
      const code = [...targets].find(candidate => queued.has(candidate));
      if (!code) break;
      const job = queued.get(code)!;
      queued.delete(code);
      running.add(job);
      // Invoke load immediately so callers can observe the real active request count.
      void (async () => {
        try {
          const data = await options.load(code, job.controller.signal);
          if (disposed || job.controller.signal.aborted || !targets.has(code)) { job.settle(false); return; }
          const weight=Math.max(0,options.weight?.(data)??0);
          while (resident.size >= capacity || resident.size>0&&[...resident.values()].reduce((a,b)=>a+b,0)+weight>(options.maxWeight??Infinity)) {
            const oldest = [...resident.keys()].find(candidate => !targets.has(candidate));
            // Every resident country is on screen too: show them all rather than silently drop this one.
            if (!oldest) break;
            options.unmount(oldest);
            resident.delete(oldest);
          }
          options.mount(code, data);
          resident.set(code, weight);
          failed.delete(code);
          job.settle(true);
        } catch (error) {
          if (!disposed && !job.controller.signal.aborted && targets.has(code)) {
            failed.set(code, Date.now());
            options.onError?.(code, error);
          }
          job.settle(false);
        } finally {
          running.delete(job);
          pump();
          notify();
        }
      })();
    }
    notify();
  }

  function setTargets(codes: string[]) {
    if (disposed) return;
    const ordered = [...new Set(codes)].slice(0, capacity);
    targets = new Set(ordered);
    for (const [code, job] of queued) if (!targets.has(code)) { queued.delete(code); cancel(job); }
    for (const job of running) if (!targets.has(job.code)) cancel(job);
    // Keep higher-priority visible countries most recently used.
    for (const code of [...ordered].reverse()) touch(code);
    for (const code of ordered) enqueue(code);
    pump();
  }

  return {
    setTargets,
    request(code) {
      if (disposed) return Promise.resolve(false);
      failed.delete(code); // an explicit retry must not wait for the viewport cooldown
      setTargets([code, ...targets]);
      if (resident.has(code)) { touch(code); return Promise.resolve(true); }
      return active(code)?.promise ?? Promise.resolve(false);
    },
    release() {
      if (disposed) return [];
      const released = [...resident.keys()].filter(code => !targets.has(code));
      for (const code of released) { options.unmount(code); resident.delete(code); }
      return released;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const job of queued.values()) cancel(job);
      for (const job of running) cancel(job);
      queued.clear();
      for (const code of resident.keys()) options.unmount(code);
      resident.clear();
      targets.clear();
      notify();
    },
  };
}
