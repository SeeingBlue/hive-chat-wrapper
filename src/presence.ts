// Honest presence (Design §3.2, §3.3, §5.4). The agent chooses its rooms
// (desired); the wrapper joins them only while connected and listening, at
// most 5 at once, and steps the mode down with the governor tier:
// full → as chosen, present tier → present, exhausted → leave and watch.
// Presence is never simulated: `joined` mirrors server-confirmed state only.
// The one exception to choosing is the room the session marks as the house room
// (pinned): the platform holds the agent there, so it is never left at any tier
// and takes none of the 5 slots. Its mode still follows the choice and the tier.
import { HiveError } from './transport.ts';
import type { HiveApi, PresenceMode } from './protocol.ts';
import type { GovTier } from './governor.ts';
import { errText } from './util.ts';
import type { LogFn } from './util.ts';

export interface PresenceHooks {
  beforeJoin(roomId: string, mode: PresenceMode): void;
  joined(roomId: string, mode: PresenceMode, isNew: boolean): void;
  joinFailed(roomId: string): void;
  left(roomId: string): void;
}

export class Presence {
  readonly maxRooms: number;
  readonly desired = new Map<string, PresenceMode>(); // the agent's own choices
  readonly joined = new Map<string, PresenceMode>(); // server-confirmed, this session
  readonly watches = new Set<string>(); // the agent's own watch choices
  readonly watchedNow = new Set<string>(); // server-confirmed watches
  pinned: string | null = null; // the house room, as the session marks it
  tier: GovTier = 'full';
  joinRetryAt = 0;
  private readonly log: LogFn;

  constructor(maxRooms: number, log: LogFn) {
    this.maxRooms = Math.min(5, maxRooms);
    this.log = log;
  }

  effective(mode: PresenceMode): PresenceMode | null {
    if (this.tier === 'exhausted') return null;
    if (this.tier === 'present') return 'present';
    return mode;
  }

  // Rooms the agent can be in right now, counting the one that takes no slot.
  roomLimit(): number {
    return this.pinned ? this.maxRooms + 1 : this.maxRooms;
  }

  // spareSlots: restored choices are read before any session can mark the house
  // room, and one of them may be it.
  want(roomId: string, mode: PresenceMode, spareSlots = 0): boolean {
    const used = this.desired.size - (this.pinned && this.desired.has(this.pinned) ? 1 : 0);
    if (roomId !== this.pinned && !this.desired.has(roomId) && used >= this.maxRooms + spareSlots) return false;
    this.desired.set(roomId, mode);
    return true;
  }

  drop(roomId: string): void {
    this.desired.delete(roomId);
    if (roomId === this.pinned) this.pinned = null;
  }

  // Presence lives only as long as the session's stream.
  disconnected(): void {
    this.joined.clear();
    this.watchedNow.clear();
  }

  private target(): Map<string, PresenceMode> {
    const target = new Map<string, PresenceMode>();
    if (this.pinned) target.set(this.pinned, this.effective(this.desired.get(this.pinned) ?? 'present') ?? 'present');
    let slots = 0;
    for (const [room, mode] of this.desired) {
      if (room === this.pinned) continue;
      const m = this.effective(mode);
      if (m && slots < this.maxRooms) {
        target.set(room, m);
        slots++;
      }
    }
    return target;
  }

  // Brings server state in line with the agent's choices and the budget tier.
  // Returns rooms newly joined (they need catch-up).
  async reconcile(api: HiveApi, hooks: PresenceHooks, now: number): Promise<string[]> {
    const target = this.target();
    for (const room of [...this.joined.keys()]) {
      if (target.has(room)) continue;
      try {
        await api.leave(room);
      } catch (e) {
        this.log('warn', `leave ${room} failed: ${errText(e)}`);
      }
      this.joined.delete(room);
      hooks.left(room);
    }
    const newly: string[] = [];
    for (const [room, mode] of target) {
      if (this.joined.get(room) === mode) continue;
      const isNew = !this.joined.has(room);
      if (isNew && now < this.joinRetryAt && room !== this.pinned) continue; // the pinned room spends no token
      if (isNew) hooks.beforeJoin(room, mode);
      try {
        await api.join(room, mode);
        this.joined.set(room, mode);
        hooks.joined(room, mode, isNew);
        if (isNew) newly.push(room);
      } catch (e) {
        if (isNew) hooks.joinFailed(room);
        if (e instanceof HiveError && e.isThrottle) {
          this.joinRetryAt = now + (e.retryAfterMs ?? 60_000);
          continue;
        }
        if (e instanceof HiveError && (e.code === 'room_archived' || e.code === 'not_found')) {
          this.drop(room);
          this.watches.delete(room);
        }
        this.log('warn', `join ${room} failed: ${errText(e)}`);
      }
    }
    const wantWatch = new Set<string>(this.watches);
    if (this.tier === 'exhausted') for (const room of this.desired.keys()) wantWatch.add(room);
    for (const room of this.joined.keys()) wantWatch.delete(room);
    for (const room of [...this.watchedNow]) {
      if (wantWatch.has(room)) continue;
      try {
        await api.unwatch(room);
      } catch {
        // unsubscribing is best effort
      }
      this.watchedNow.delete(room);
    }
    for (const room of wantWatch) {
      if (this.watchedNow.has(room)) continue;
      try {
        await api.watch(room);
        this.watchedNow.add(room);
      } catch (e) {
        if (e instanceof HiveError && e.code === 'not_found') this.watches.delete(room);
        this.log('warn', `watch ${room} failed: ${errText(e)}`);
      }
    }
    return newly;
  }

  // True when a room the agent chose is not (or not yet correctly) joined and
  // a join may be attempted now: failed or throttled joins are retried.
  pending(now: number): boolean {
    if (now < this.joinRetryAt) return false;
    for (const [room, mode] of this.target()) {
      if (this.joined.get(room) !== mode) return true;
    }
    return false;
  }

  // Leave every room on shutdown (best effort, bounded wait).
  async leaveAll(api: HiveApi, timeoutMs = 3000): Promise<void> {
    const rooms = [...this.joined.keys()].filter((r) => r !== this.pinned);
    const work = Promise.allSettled(rooms.map((r) => api.leave(r)));
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
    this.joined.clear();
  }
}
