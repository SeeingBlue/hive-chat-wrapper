// The AI-news wire as optional conversation material: fetched at startup and
// then at most hourly (every 10 minutes under newsSpark, stretched while the wire
// is quiet), cached in memory, failures ignored silently. This only supplies text
// for frames and reports what it fetched. It never triggers a model call or a post
// itself: the news spark is the agent's decision, in spark.ts and compose.ts.
import { HOUR_MS, DAY_MS, errText, readJson, writePrivate } from './util.ts';
import type { LogFn } from './util.ts';

export const DEFAULT_WIRE_URL = 'https://hive-chat.com/wire.json';
export const WIRE_FRAME_MAX = 5;
export const WIRE_SPARK_INTERVAL_MS = 600_000;
export const WIRE_DELIVERED_FILE = 'wire-delivered.json';
export const WIRE_DELIVERED_MAX = 200;
const HEADLINE_MAX = 200;
const SOURCE_MAX = 60;
const FETCH_TIMEOUT_MS = 15_000;
// Room for five articles at the poller's 100,000-character bound, JSON-escaped.
// A smaller limit here would silently lose the whole wire.
const MAX_BODY_CHARS = 2 * 1024 * 1024;

export interface WireHeadline {
  headline: string;
  source: string;
  articleText?: string;
  delivered?: boolean; // this agent has had the full text, so the frame leaves it out
}

export interface CachedItem extends WireHeadline {
  firstSeenAt: number;
}

export type WireFetcher = (signal: AbortSignal) => Promise<unknown>;

export function wireIntervalMs(newsSpark: boolean): number {
  return newsSpark ? WIRE_SPARK_INTERVAL_MS : HOUR_MS;
}

export function wireFetcherFor(url: string): WireFetcher {
  return async (signal) => {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) throw new Error('wire too large');
    return JSON.parse(text);
  };
}

function plain(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const flat = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, max).join('');
}

// Full length, with its paragraph breaks kept: any shrinking is the frame's job.
function articlePlain(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .split(/\n{2,}/)
    .map((p) => plain(p, Infinity))
    .filter(Boolean)
    .join('\n\n');
}

function parseItems(body: unknown): CachedItem[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: CachedItem[] = [];
  for (const it of items) {
    const o = (it ?? {}) as Record<string, unknown>;
    const headline = plain(o.headline, HEADLINE_MAX);
    const source = plain(o.source, SOURCE_MAX);
    const firstSeenAt = Date.parse(String(o.firstSeenAt));
    const articleText = articlePlain(o.articleText);
    if (headline && source && Number.isFinite(firstSeenAt)) out.push({ headline, source, firstSeenAt, ...(articleText ? { articleText } : {}) });
  }
  return out;
}

// The platform answers with a null generatedAt before the poller's first cycle
// or when its file is unreadable. That is no wire at all, not an empty one.
function isPublished(body: unknown): boolean {
  const b = body as { generatedAt?: unknown; items?: unknown } | null;
  return typeof b?.generatedAt === 'string' && Array.isArray(b.items);
}

export class WireCache {
  private items: CachedItem[] = [];
  private lastAttemptAt: number | null = null;
  private inFlight = false;
  private readonly abort = new AbortController();
  private readonly fetcher: WireFetcher;
  private readonly now: () => number;
  private readonly intervalMs: number | (() => number);
  private readonly onPublished: ((items: CachedItem[]) => void) | null;

  constructor(fetcher: WireFetcher, now: () => number, intervalMs: number | (() => number) = HOUR_MS, onPublished: ((items: CachedItem[]) => void) | null = null) {
    this.fetcher = fetcher;
    this.now = now;
    this.intervalMs = intervalMs;
    this.onPublished = onPublished;
  }

  // Fetches when no attempt was made in the last interval, success or not.
  refreshIfDue(): Promise<void> {
    const now = this.now();
    if (this.inFlight || this.abort.signal.aborted) return Promise.resolve();
    const interval = typeof this.intervalMs === 'function' ? this.intervalMs() : this.intervalMs;
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < interval) return Promise.resolve();
    this.lastAttemptAt = now;
    this.inFlight = true;
    return this.fetcher(this.abort.signal)
      .then((body) => {
        this.items = parseItems(body);
        if (this.onPublished && !this.abort.signal.aborted && isPublished(body)) this.onPublished(this.items);
      })
      .catch(() => {
        // keep what is cached; the wire is optional
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  // Items past their 24 hours drop out even if the next fetch has not happened.
  current(): WireHeadline[] {
    return this.identified().map(({ firstSeenAt: _seen, ...item }) => item);
  }

  identified(): CachedItem[] {
    const now = this.now();
    return this.items.filter((it) => now - it.firstSeenAt < DAY_MS).slice(0, WIRE_FRAME_MAX);
  }

  stop(): void {
    this.abort.abort();
  }
}

type Identity = { headline: string; source: string; firstSeenAt: number };

function identityKey(it: Identity): string {
  return JSON.stringify([it.headline, it.source, it.firstSeenAt]);
}

// Which stories this agent has already had in full, kept in the state dir so a
// restart does not pay for them again. A story pushed out of the top 5 can return
// while it is still inside its 24 hours, so an identity off the wire is forgotten
// only once it can no longer come back. An unreadable record reads as empty: the
// cost is one more delivery of what is on the wire now.
export class WireDelivered {
  private readonly seen = new Map<string, Identity>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: LogFn;

  constructor(file: string, now: () => number, log: LogFn) {
    this.file = file;
    this.now = now;
    this.log = log;
    const saved = readJson<{ delivered?: unknown } | null>(file, null)?.delivered;
    if (!Array.isArray(saved)) return;
    for (const it of saved as Identity[]) {
      if (typeof it?.headline === 'string' && typeof it?.source === 'string' && typeof it?.firstSeenAt === 'number') this.seen.set(identityKey(it), { headline: it.headline, source: it.source, firstSeenAt: it.firstSeenAt });
    }
  }

  has(it: Identity): boolean {
    return this.seen.has(identityKey(it));
  }

  add(items: Identity[]): void {
    let changed = false;
    for (const { headline, source, firstSeenAt } of items) {
      if (this.has({ headline, source, firstSeenAt })) continue;
      this.seen.set(identityKey({ headline, source, firstSeenAt }), { headline, source, firstSeenAt });
      changed = true;
    }
    if (this.cap() || changed) this.save();
  }

  // Given what a real fetch published. A failed fetch says nothing about the wire.
  prune(onWire: Identity[]): void {
    const now = this.now();
    const live = new Set(onWire.map(identityKey));
    let changed = false;
    for (const [key, it] of this.seen) {
      if (live.has(key) || now - it.firstSeenAt < DAY_MS) continue;
      this.seen.delete(key);
      changed = true;
    }
    if (this.cap() || changed) this.save();
  }

  // Past the limit the oldest stories go first: they are the least likely to return.
  private cap(): boolean {
    if (this.seen.size <= WIRE_DELIVERED_MAX) return false;
    const oldest = [...this.seen].sort((a, b) => a[1].firstSeenAt - b[1].firstSeenAt).slice(0, this.seen.size - WIRE_DELIVERED_MAX);
    for (const [key] of oldest) this.seen.delete(key);
    return true;
  }

  private save(): void {
    try {
      writePrivate(this.file, JSON.stringify({ delivered: [...this.seen.values()] }));
    } catch (e) {
      this.log('warn', `saving the delivered wire record failed: ${errText(e)}`);
    }
  }
}
