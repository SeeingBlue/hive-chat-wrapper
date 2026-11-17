// Social initiative: the two triggers that do not wait for a message, a news story
// or a directory change. Arrivals keeps who has been seen in each room, so a
// newcomer gets one conversation call and a returning agent none. HeartbeatCap
// keeps the heartbeat calls of the last 24 hours in the state dir, so a restart
// cannot reset the cap. Both are at-most-once: a call is accounted for before it
// starts, whatever then becomes of it, so nothing here can retry.
import fs from 'node:fs';
import type { Occupant } from './protocol.ts';
import { DAY_MS, errText, writePrivate } from './util.ts';
import type { LogFn } from './util.ts';

export const HEARTBEAT_FILE = 'heartbeat.json';

// Arrivals in one room this close to the first share its call. The window never
// extends, so a stream of arrivals cannot put the call off for ever.
export const ARRIVAL_BATCH_MS = 30_000;

// How often, on average, the heartbeat looks for a quiet room.
export const HEARTBEAT_EVAL_MS = 20 * 60_000;

// Half to one and a half of the average, so agents started together drift apart.
export function heartbeatDelayMs(random: () => number = Math.random): number {
  return HEARTBEAT_EVAL_MS * (0.5 + random());
}

export type SocialDue = { kind: 'arrival'; names: string[] } | { kind: 'heartbeat'; quietMs: number };

function loadSeen(saved: unknown): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return seen;
  for (const [room, ids] of Object.entries(saved)) {
    if (Array.isArray(ids)) seen.set(room, new Set(ids.filter((id) => typeof id === 'string')));
  }
  return seen;
}

export class Arrivals {
  private readonly seen: Map<string, Set<string>>;
  private readonly selfId: string;
  private readonly ignored: (agentId: string) => boolean;
  // Rooms whose current stay has had its first look. Whoever is there at that look
  // was there before this agent: they did not just join, so they count as seen.
  private readonly settled = new Set<string>();
  private readonly batches = new Map<string, { dueAt: number; names: Map<string, string> }>();

  constructor(saved: unknown, selfId: string, ignored: (agentId: string) => boolean) {
    this.seen = loadSeen(saved);
    this.selfId = selfId;
    this.ignored = ignored;
  }

  // Returns true when the persisted record changed, so the caller can save it
  // before any call: a crash must not greet the same agent twice.
  observe(roomId: string, occupants: Occupant[], now: number): boolean {
    const seen = this.seen.get(roomId) ?? new Set<string>();
    this.seen.set(roomId, seen);
    const firstLook = !this.settled.has(roomId);
    this.settled.add(roomId);
    let changed = false;
    for (const o of occupants) {
      if (!o || typeof o.id !== 'string' || o.id === this.selfId || seen.has(o.id)) continue;
      seen.add(o.id);
      changed = true;
      if (firstLook || this.ignored(o.id)) continue;
      const batch = this.batches.get(roomId) ?? { dueAt: now + ARRIVAL_BATCH_MS, names: new Map<string, string>() };
      batch.names.set(o.id, typeof o.display === 'string' ? o.display : o.id);
      this.batches.set(roomId, batch);
    }
    return changed;
  }

  // Taking a batch ends its one chance.
  takeDue(now: number): { roomId: string; names: string[] } | null {
    for (const [roomId, batch] of this.batches) {
      if (now < batch.dueAt) continue;
      this.batches.delete(roomId);
      return { roomId, names: [...batch.names.values()] };
    }
    return null;
  }

  // The stay in this room ended: the next one takes a new first look.
  left(roomId: string): void {
    this.settled.delete(roomId);
    this.batches.delete(roomId);
  }

  // A batch can outlive a dropped stream; the rooms' first looks cannot.
  disconnected(): void {
    this.settled.clear();
  }

  // Waiting for budget would be a retry. Returns how many batches were dropped.
  dropAll(): number {
    const n = this.batches.size;
    this.batches.clear();
    return n;
  }

  toJSON(): Record<string, string[]> {
    return Object.fromEntries([...this.seen].map(([room, ids]) => [room, [...ids]]));
  }
}

// No file is an empty record; a file that cannot be read as one is null.
function readFired(file: string): number[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  try {
    const list = JSON.parse(text)?.fired;
    return Array.isArray(list) ? list.filter((t) => typeof t === 'number' && Number.isFinite(t)) : null;
  } catch {
    return null;
  }
}

export class HeartbeatCap {
  private fired: number[];
  private readonly maxPerDay: number;
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: LogFn;

  constructor(file: string, maxPerDay: number, now: () => number, log: LogFn) {
    this.file = file;
    this.maxPerDay = maxPerDay;
    this.now = now;
    this.log = log;
    const saved = readFired(file);
    if (saved) {
      this.fired = saved;
    } else {
      // An unreadable record cannot prove the cap has room: count it as spent for a
      // day rather than let damage to the file reset the cap.
      this.log('warn', 'the heartbeat record is unreadable; no heartbeat for 24 hours');
      this.fired = new Array<number>(maxPerDay).fill(now());
      this.save();
    }
  }

  left(): number {
    const now = this.now();
    this.fired = this.fired.filter((t) => now - t < DAY_MS); // a future time stays counted
    return this.maxPerDay - this.fired.length;
  }

  // Written before the call starts, so a crash mid-call cannot give it back. False
  // means no room left, or the record could not be written: the call must not start.
  record(): boolean {
    if (this.left() <= 0) return false;
    this.fired.push(this.now());
    if (this.save()) return true;
    this.fired.pop();
    return false;
  }

  private save(): boolean {
    try {
      writePrivate(this.file, JSON.stringify({ fired: this.fired }));
      return true;
    } catch (e) {
      this.log('warn', `saving the heartbeat record failed: ${errText(e)}`);
      return false;
    }
  }
}
