/**
 * Keep the app running: when it stops on its own, start it again after 2, 5, 10, 30, 60 seconds.
 * Five crashes within 10 minutes: give up (something is wrong that a restart does not fix).
 */
import type { ChildProcess } from 'node:child_process';

export type Say = (line: string) => void;

export interface SuperviseOptions {
  /** Start the app (a new process each time). */
  spawnApp: () => ChildProcess;
  say: Say;
  /** Called once when it gives up; the caller stops everything. */
  giveUp: (message: string) => void;
  /** Resolves true once a restarted app answers (false: it stopped again first, or never answered). */
  answering?: (child: ChildProcess) => Promise<boolean>;
  delaysMs?: number[];
  maxCrashes?: number;
  windowMs?: number;
}

export interface Supervisor {
  /** The app process running now (null while waiting to start it again). */
  child(): ChildProcess | null;
  crashes(): number;
  /** Stop restarting and stop the app. */
  stop(): void;
}

export const CRASH_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export function superviseApp(o: SuperviseOptions): Supervisor {
  const delays = o.delaysMs ?? CRASH_DELAYS_MS;
  const max = o.maxCrashes ?? 5;
  const windowMs = o.windowMs ?? 600_000;
  const times: number[] = [];
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: ChildProcess | null = null;

  function run(): void {
    const c = o.spawnApp();
    current = c;
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      if (stopped || current !== c) return;
      current = null;
      crashed(why);
    };
    c.on('error', (e) => end((e as NodeJS.ErrnoException).code || e.message));
    c.on('exit', (code, signal) => end(String(signal ?? code)));
  }

  function crashed(why: string): void {
    const now = Date.now();
    times.push(now);
    while (times.length && now - times[0] > windowMs) times.shift();
    const k = times.length;
    if (k >= max) {
      stopped = true;
      o.say(`The app stopped (${why}).`);
      o.giveUp(`the app crashed ${max} times in 10 minutes. The last lines are in logs/start.log.`);
      return;
    }
    const delay = delays[Math.min(k - 1, delays.length - 1)];
    o.say(`The app stopped (${why}). Starting it again in ${delay / 1000} seconds (crash ${k} of ${max} in 10 minutes).`);
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      run();
      const c = current;
      if (!c || !o.answering) return;
      const up = await o.answering(c).catch(() => false);
      if (up && !stopped && current === c) o.say('The app is running again.');
    }, delay);
  }

  run();
  return {
    child: () => current,
    crashes: () => times.length,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const c = current;
      if (c && c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
    },
  };
}
