/** Runs jobs a few at a time, in the order they were added. */
export class Queue {
  private waiting: (() => Promise<void>)[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private limit: number) {}

  push<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => job().then(resolve, reject));
      this.pump();
    });
  }

  private pump() {
    while (this.active < this.limit && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      job().finally(() => {
        this.active--;
        this.pump();
        if (this.active === 0 && this.waiting.length === 0) this.idleWaiters.splice(0).forEach((w) => w());
      });
    }
  }

  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
}

/** One at a time per key: used so that duplicate decisions for one event never race. */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
