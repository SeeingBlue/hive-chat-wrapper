// The resident news spark's memory: which wire items this agent has already
// accounted for, kept in the state dir so a restart does not spark again. The
// first real wire it sees is a baseline. An item is accounted for the moment it
// is seen. If the governor refuses its one call, the item waits in the pending
// queue, in the same file, for a later attempt instead of being lost; nothing
// else is retried. It also keeps the time of the last new item, which sets the
// cooldown.
import fs from 'node:fs';
import type { CooldownConfig } from './config.ts';
import { DAY_MS, errText, readJson, writePrivate } from './util.ts';
import type { LogFn } from './util.ts';

export const NEWS_SPARK_FILE = 'news-spark.json';

// Far more than a day of wire churn needs, and only five can be on the wire at
// once. Past it the stories nearest their 24 hours go first.
export const SPARK_PENDING_MAX = 50;

// Longer than an item can stay on the wire. A story pushed out of the top 5 can
// return later, so an identity must outlive its absence from a fetch.
const RETAIN_MS = 2 * DAY_MS;

export interface WireIdentity {
  headline: string;
  firstSeenAt: number;
}

export interface PendingSpark extends WireIdentity {
  pendingSince: number; // when its call was first refused
}

function keyOf(it: WireIdentity): string {
  return `${it.firstSeenAt} ${it.headline}`;
}

// How far the review and wire intervals are stretched after this much wire quiet:
// base until the threshold, then one step along the curve per further threshold.
export function cooldownMultiplier(quietMs: number, c: CooldownConfig): number {
  if (quietMs < c.quietThresholdMs) return 1;
  const step = Math.floor(quietMs / c.quietThresholdMs) - 1;
  return c.multiplierCurve[Math.min(step, c.multiplierCurve.length - 1)];
}

function loadSeen(saved: unknown): Map<string, number> | null {
  if (!Array.isArray(saved)) return null;
  const seen = new Map<string, number>();
  for (const it of saved as WireIdentity[]) {
    if (typeof it?.headline === 'string' && typeof it?.firstSeenAt === 'number') seen.set(keyOf(it), it.firstSeenAt);
  }
  return seen;
}

function loadPending(saved: unknown): PendingSpark[] {
  if (!Array.isArray(saved)) return [];
  const pending: PendingSpark[] = [];
  for (const it of saved as PendingSpark[]) {
    if (typeof it?.headline === 'string' && typeof it?.firstSeenAt === 'number' && typeof it?.pendingSince === 'number') pending.push({ headline: it.headline, firstSeenAt: it.firstSeenAt, pendingSince: it.pendingSince });
  }
  return pending;
}

// Turning the feature off forgets the baseline, so that turning it on again
// starts from the wire of that moment rather than sparking the gap. The pending
// queue goes with it.
export function forgetNewsSpark(file: string, log: LogFn): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    log('warn', `clearing the news spark state failed: ${errText(e)}`);
  }
}

export class NewsSpark {
  private seen: Map<string, number> | null;
  private pending: PendingSpark[];
  private lastNewAt: number;
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: LogFn;

  constructor(file: string, now: () => number, log: LogFn) {
    this.file = file;
    this.now = now;
    this.log = log;
    const saved = readJson<{ seen?: unknown; lastNewAt?: unknown; pending?: unknown } | null>(file, null);
    this.seen = loadSeen(saved?.seen);
    // Without a baseline nothing can have been refused: a damaged record sparks nothing.
    this.pending = this.seen ? loadPending(saved?.pending) : [];
    this.lastNewAt = typeof saved?.lastNewAt === 'number' ? saved.lastNewAt : now();
  }

  // How long the wire has gone without a genuinely new item.
  quietMs(): number {
    return this.now() - this.lastNewAt;
  }

  // Accounts for one fetch's items and returns the ones that are new. An item
  // already past its 24 hours is accounted for but never news, and a pending one
  // past its 24 hours has left the wire for good.
  noteItems(items: WireIdentity[]): WireIdentity[] {
    const now = this.now();
    const baseline = this.seen === null;
    const seen = this.seen ?? new Map<string, number>();
    const fresh: WireIdentity[] = [];
    let changed = baseline;
    for (const it of items) {
      const key = keyOf(it);
      if (seen.has(key)) continue;
      seen.set(key, it.firstSeenAt);
      changed = true;
      if (!baseline && now - it.firstSeenAt < DAY_MS) fresh.push({ headline: it.headline, firstSeenAt: it.firstSeenAt });
    }
    for (const [key, at] of seen) {
      if (now - at < RETAIN_MS) continue;
      seen.delete(key);
      changed = true;
    }
    const live = this.pending.filter((p) => now - p.firstSeenAt < DAY_MS);
    if (live.length !== this.pending.length) {
      this.pending = live;
      changed = true;
    }
    this.seen = seen;
    if (fresh.length > 0) this.lastNewAt = now;
    if (changed) this.save();
    return fresh;
  }

  // The headlines of noteItems().
  note(items: WireIdentity[]): string[] {
    return this.noteItems(items).map((it) => it.headline);
  }

  pendingCount(): number {
    return this.pending.length;
  }

  // The pending stories the wire still shows, taken for one call. They leave the
  // queue, on disk too, before the call can start: a crash during it cannot spark
  // them twice. One off the wire stays, since it can still come back.
  takePending(onWire: WireIdentity[]): PendingSpark[] {
    const now = this.now();
    const live = new Set(onWire.map(keyOf));
    const taken = this.pending.filter((p) => live.has(keyOf(p)) && now - p.firstSeenAt < DAY_MS);
    if (taken.length === 0) return [];
    this.pending = this.pending.filter((p) => !taken.includes(p));
    this.save();
    return taken;
  }

  // A refused call: its stories wait for a later attempt. One refused before keeps
  // the time it was first refused. Returns how many are pending now.
  defer(items: Array<WireIdentity & { pendingSince?: number }>): number {
    if (this.seen === null) return 0;
    const now = this.now();
    const have = new Set(this.pending.map(keyOf));
    for (const it of items) {
      const key = keyOf(it);
      if (have.has(key) || now - it.firstSeenAt >= DAY_MS) continue;
      have.add(key);
      this.pending.push({ headline: it.headline, firstSeenAt: it.firstSeenAt, pendingSince: it.pendingSince ?? now });
    }
    if (this.pending.length > SPARK_PENDING_MAX) this.pending = [...this.pending].sort((a, b) => b.firstSeenAt - a.firstSeenAt).slice(0, SPARK_PENDING_MAX);
    this.save();
    return this.pending.length;
  }

  private save(): void {
    if (!this.seen) return;
    const list = [...this.seen].map(([key, firstSeenAt]) => ({ headline: key.slice(key.indexOf(' ') + 1), firstSeenAt }));
    try {
      writePrivate(this.file, JSON.stringify({ seen: list, lastNewAt: this.lastNewAt, pending: this.pending }));
    } catch (e) {
      this.log('warn', `saving the news spark state failed: ${errText(e)}`);
    }
  }
}
