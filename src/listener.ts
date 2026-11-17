// Listening discipline (Design §3.3): per-room buffers, chunk rhythms, the
// deterministic no-model pre-filter, and the per-author delivery bound.
// No model runs per message; the buffer loses nothing (collapsed and backlog
// items stay held until expanded or aged out of the digest window).
import type { ChatMessage, Tombstone, PresenceMode } from './protocol.ts';
import type { ListeningConfig } from './config.ts';
import { cpLength, HOUR_MS } from './util.ts';

export interface MsgItem {
  kind: 'message';
  changeId: string;
  msg: ChatMessage;
  arrivedAt: number;
  trigger: string | null;
  repeats?: number;
}

export interface IgnoredItem {
  kind: 'ignored';
  changeId: string;
  seqFrom: number;
  seqTo: number;
  arrivedAt: number;
}

export type BufItem = MsgItem | IgnoredItem;

export interface CollapsedNote {
  authorId: string;
  displayAtPost: string;
  count: number;
  chars: number;
}

export type ChunkReason = 'trigger' | 'expand' | 'size' | 'catchup' | 'rhythm' | 'recheck';

export interface ChunkPlan {
  roomId: string;
  mode: PresenceMode;
  reason: ChunkReason;
  deliver: BufItem[];
  collapsed: CollapsedNote[];
  backlog: number; // older catch-up items held back (recency-first), expandable
  earlier: MsgItem[];
  triggerHits: number;
  dirty: boolean;
  // bookkeeping for commit()
  consumed: number;
  expandTaken: number;
  newlyCollapsed: MsgItem[];
  newBacklog: BufItem[];
  charges: Array<[string, number]>;
}

interface RoomState {
  roomId: string;
  mode: PresenceMode;
  pending: BufItem[];
  recent: MsgItem[];
  collapsed: Map<string, MsgItem[]>;
  backlog: BufItem[];
  expandQueue: MsgItem[];
  delivered: Map<string, Array<{ at: number; chars: number }>>;
  engaged: Map<string, number>;
  ownIds: Set<string>;
  consumedIds: Set<string>;
  authorOf: Map<string, string>;
  triggerTimes: number[];
  immediate: boolean;
  dirty: boolean;
  catchupPending: boolean;
  lastChunkAt: number;
  notBefore: number;
  active: boolean;
}

const ID_CAP = 5000;

function capSet(s: Set<string>, id: string): void {
  s.add(id);
  if (s.size > ID_CAP) {
    const first = s.values().next().value;
    if (first !== undefined) s.delete(first);
  }
}

export function messageText(m: ChatMessage): string {
  if (m.state === 'normal') return m.body ?? '';
  if (m.state === 'redacted' && m.segments) {
    let s = '';
    for (const seg of m.segments) if ('text' in seg) s += seg.text;
    return s;
  }
  return '';
}

export function messageChars(m: ChatMessage): number {
  return cpLength(messageText(m));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Listener {
  readonly p: ListeningConfig;
  selfId = '';
  private nameRe: RegExp | null = null;
  follows = new Set<string>();
  ignores = new Set<string>();
  private readonly rooms = new Map<string, RoomState>();

  constructor(p: ListeningConfig) {
    this.p = p;
  }

  setSelf(id: string, name: string): void {
    this.selfId = id;
    const n = name.trim();
    this.nameRe = n.length >= 2 ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, 'iu') : null;
  }

  // --- room lifecycle
  addRoom(roomId: string, mode: PresenceMode): void {
    const r = this.rooms.get(roomId);
    if (r) {
      r.mode = mode;
      r.active = true;
      return;
    }
    this.rooms.set(roomId, {
      roomId,
      mode,
      pending: [],
      recent: [],
      collapsed: new Map(),
      backlog: [],
      expandQueue: [],
      delivered: new Map(),
      engaged: new Map(),
      ownIds: new Set(),
      consumedIds: new Set(),
      authorOf: new Map(),
      triggerTimes: [],
      immediate: false,
      dirty: false,
      catchupPending: false,
      lastChunkAt: 0,
      notBefore: 0,
      active: true,
    });
  }

  removeRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  // Not joined right now (stepped down or disconnected): keep the buffer, no chunks.
  deactivate(roomId: string): void {
    const r = this.rooms.get(roomId);
    if (r) r.active = false;
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  modeOf(roomId: string): PresenceMode | null {
    return this.rooms.get(roomId)?.mode ?? null;
  }

  markCatchup(roomId: string): void {
    const r = this.rooms.get(roomId);
    if (r && r.pending.length > 0) r.catchupPending = true;
  }

  defer(roomId: string, untilMs: number): void {
    const r = this.rooms.get(roomId);
    if (r) r.notBefore = untilMs;
  }

  // Recency-first return: purge every cached copy before applying a tail.
  // Consumed IDs are kept (IDs only, no content) so already-read messages
  // come back as context rather than as new items.
  resetForTail(roomId: string): void {
    const r = this.rooms.get(roomId);
    if (!r) return;
    r.pending = [];
    r.recent = [];
    r.collapsed.clear();
    r.backlog = [];
    r.expandQueue = [];
    r.immediate = false;
    r.dirty = false;
  }

  // --- ingest
  prefilter(roomId: string, m: ChatMessage): string | null {
    const r = this.rooms.get(roomId);
    if (!r || m.author_id === this.selfId) return null;
    const text = messageText(m);
    const question = text.trim().endsWith('?');
    const mentioned = m.mentions.includes(this.selfId);
    const repliedTo = m.reply_to !== null && r.ownIds.has(m.reply_to);
    if ((mentioned || repliedTo) && question) return 'direct_question';
    if (mentioned) return 'mention';
    if (repliedTo) return 'reply';
    if (this.follows.has(m.author_id) && !this.ignores.has(m.author_id)) return 'followed_author';
    if (this.nameRe && this.nameRe.test(text)) return 'name';
    return null;
  }

  ingest(roomId: string, item: BufItem, now: number, catchup = false): void {
    const r = this.rooms.get(roomId);
    if (!r) return;
    if (item.kind === 'ignored') {
      const last = r.pending[r.pending.length - 1];
      if (last && last.kind === 'ignored' && item.seqFrom <= last.seqTo + 1 && item.seqTo >= last.seqFrom - 1) {
        last.seqFrom = Math.min(last.seqFrom, item.seqFrom);
        last.seqTo = Math.max(last.seqTo, item.seqTo);
      } else {
        r.pending.push(item);
      }
      return;
    }
    const m = item.msg;
    r.authorOf.set(m.id, m.author_id);
    if (r.authorOf.size > ID_CAP) {
      const first = r.authorOf.keys().next().value;
      if (first !== undefined) r.authorOf.delete(first);
    }
    if (m.author_id === this.selfId) {
      const t = Date.parse(m.created_at);
      this.noteEngagement(r, m, Number.isFinite(t) ? Math.min(t, now) : now);
      if (!r.recent.some((x) => x.msg.id === m.id)) this.pushRecent(r, item);
      return;
    }
    if (r.consumedIds.has(m.id)) {
      if (!r.recent.some((x) => x.msg.id === m.id)) this.pushRecent(r, item);
      return;
    }
    if (r.pending.some((x) => x.kind === 'message' && x.msg.id === m.id)) return;
    const reason = this.prefilter(roomId, m);
    item.trigger = reason;
    if (reason && !catchup) {
      r.triggerTimes = r.triggerTimes.filter((t) => now - t < HOUR_MS);
      if (!r.immediate) {
        if (r.triggerTimes.length < this.p.triggerCapPerHour) {
          r.triggerTimes.push(now);
          r.immediate = true;
        } else {
          r.dirty = true; // over the cap: wait for the next scheduled chunk
        }
      }
    }
    r.pending.push(item);
  }

  applyTombstone(roomId: string, t: Tombstone): void {
    const r = this.rooms.get(roomId);
    if (!r) return;
    const patch = (m: ChatMessage): void => {
      if (m.id !== t.message_id) return;
      m.state = t.state;
      delete m.body;
      delete m.segments;
      delete m.removed_reason;
      delete m.content_gone;
      if (t.state === 'normal' && typeof t.body === 'string') m.body = t.body;
      if (t.state === 'redacted' && Array.isArray(t.segments)) m.segments = t.segments;
      if (t.state === 'removed') {
        m.removed_reason = t.removed_reason;
        m.content_gone = t.content_gone === true;
      }
    };
    const lists: BufItem[][] = [r.pending, r.recent, r.backlog, r.expandQueue, ...r.collapsed.values()];
    for (const list of lists) for (const it of list) if (it.kind === 'message') patch(it.msg);
  }

  // --- own activity and engagement (exemption from the per-author bound)
  private noteEngagement(r: RoomState, m: ChatMessage, at: number): void {
    capSet(r.ownIds, m.id);
    if (m.reply_to) {
      const a = r.authorOf.get(m.reply_to);
      if (a && a !== this.selfId) r.engaged.set(a, Math.max(at, r.engaged.get(a) ?? 0));
    }
    for (const id of m.mentions) if (id !== this.selfId) r.engaged.set(id, Math.max(at, r.engaged.get(id) ?? 0));
  }

  noteOwnPost(roomId: string, m: ChatMessage, now: number): void {
    const r = this.rooms.get(roomId);
    if (!r) return;
    r.authorOf.set(m.id, this.selfId);
    this.noteEngagement(r, m, now);
    if (!r.recent.some((x) => x.msg.id === m.id)) this.pushRecent(r, { kind: 'message', changeId: '', msg: m, arrivedAt: now, trigger: null });
  }

  isExempt(roomId: string, authorId: string, now: number): boolean {
    const r = this.rooms.get(roomId);
    if (!r) return false;
    if (this.follows.has(authorId) && !this.ignores.has(authorId)) return true;
    const e = r.engaged.get(authorId);
    return e !== undefined && now - e <= HOUR_MS;
  }

  deliveredChars(roomId: string, authorId: string, now: number): number {
    const r = this.rooms.get(roomId);
    if (!r) return 0;
    let n = 0;
    for (const d of r.delivered.get(authorId) ?? []) if (now - d.at < HOUR_MS) n += d.chars;
    return n;
  }

  private isInbound(r: RoomState, m: ChatMessage): boolean {
    return m.mentions.includes(this.selfId) || (m.reply_to !== null && r.ownIds.has(m.reply_to));
  }

  private pushRecent(r: RoomState, it: MsgItem): void {
    r.recent.push(it);
    const keep = Math.max(this.p.recentContext * 3, 30);
    if (r.recent.length > keep) r.recent.splice(0, r.recent.length - keep);
  }

  private prune(r: RoomState, now: number): void {
    for (const [a, list] of r.delivered) {
      const kept = list.filter((d) => now - d.at < HOUR_MS);
      if (kept.length === 0) r.delivered.delete(a);
      else r.delivered.set(a, kept);
    }
    for (const [a, t] of r.engaged) if (now - t > HOUR_MS) r.engaged.delete(a);
    for (const [a, list] of r.collapsed) {
      const kept = list.filter((it) => now - it.arrivedAt < this.p.digestMaxAgeMs);
      if (kept.length === 0) r.collapsed.delete(a);
      else r.collapsed.set(a, kept);
    }
    r.backlog = r.backlog.filter((it) => now - it.arrivedAt < this.p.digestMaxAgeMs);
  }

  // --- rhythm
  // Without allowExpand (a low budget), an expansion waits while new items go on.
  dueReason(roomId: string, now: number, allowExpand = true): ChunkReason | null {
    const r = this.rooms.get(roomId);
    if (!r || !r.active || now < r.notBefore) return null;
    if (allowExpand && r.expandQueue.length > 0) return 'expand';
    if (r.pending.length === 0) return null;
    if (r.immediate) return 'trigger';
    if (r.catchupPending) return 'catchup';
    if (r.mode === 'attentive') {
      if (r.pending.length >= this.p.conversationMaxMessages) return 'size';
      if (now - r.lastChunkAt >= this.p.conversationIntervalMs) return 'rhythm';
      return null;
    }
    if (now - r.lastChunkAt >= this.p.presentIntervalMs) return 'rhythm';
    return null;
  }

  pendingAuthors(roomId: string): string[] {
    const r = this.rooms.get(roomId);
    if (!r) return [];
    const ids = new Set<string>();
    const lists: BufItem[][] = [r.pending, r.expandQueue, r.recent.slice(-this.p.recentContext)];
    for (const list of lists) {
      for (const it of list) {
        if (it.kind !== 'message') continue;
        ids.add(it.msg.author_id);
        for (const m of it.msg.mentions) ids.add(m);
      }
    }
    return [...ids];
  }

  // Non-mutating: computes what a chunk would deliver. commit() applies it.
  // 'recheck' plans view the newest pending items and are never committed.
  plan(roomId: string, now: number, reason: ChunkReason): ChunkPlan | null {
    const r = this.rooms.get(roomId);
    if (!r) return null;
    this.prune(r, now);
    const max = this.p.maxChunkItems;
    const out: ChunkPlan = {
      roomId,
      mode: r.mode,
      reason,
      deliver: [],
      collapsed: [],
      backlog: 0,
      earlier: r.recent.slice(-this.p.recentContext),
      triggerHits: 0,
      dirty: r.dirty,
      consumed: 0,
      expandTaken: 0,
      newlyCollapsed: [],
      newBacklog: [],
      charges: [],
    };
    if (reason === 'expand') {
      // The model chose to read these: its own spend decision, outside the bound.
      out.deliver = r.expandQueue.slice(0, max);
      out.expandTaken = out.deliver.length;
      return out;
    }
    let candidates: BufItem[];
    if (reason === 'recheck') {
      candidates = r.pending.slice(-max);
    } else if (r.catchupPending && r.pending.length > max) {
      // Recency-first: the newest items now, the older ones held as backlog.
      out.newBacklog = r.pending.slice(0, r.pending.length - max);
      candidates = r.pending.slice(-max);
      out.consumed = r.pending.length;
    } else {
      candidates = r.pending.slice(0, max);
      out.consumed = candidates.length;
    }
    const extra = new Map<string, number>();
    for (const it of candidates) {
      if (it.kind === 'ignored') {
        out.deliver.push(it);
        continue;
      }
      if (it.trigger) out.triggerHits++;
      const a = it.msg.author_id;
      if (a === this.selfId || this.isExempt(roomId, a, now)) {
        out.deliver.push(it);
        continue;
      }
      const chars = messageChars(it.msg);
      const used = this.deliveredChars(roomId, a, now) + (extra.get(a) ?? 0);
      if (used + chars <= this.p.authorCharsPerHour || this.isInbound(r, it.msg)) {
        // An inbound mention/reply from a non-engaged author is delivered as
        // that one turn and still counts toward the bound.
        out.deliver.push(it);
        extra.set(a, (extra.get(a) ?? 0) + chars);
        continue;
      }
      out.newlyCollapsed.push(it);
    }
    out.charges = [...extra.entries()];
    if (r.mode === 'present') out.deliver = dedupe(out.deliver);
    // Every author with held (collapsed) messages is shown as a count until
    // the model expands it or it ages out of the digest window.
    const authors = new Set([...r.collapsed.keys(), ...out.newlyCollapsed.map((it) => it.msg.author_id)]);
    for (const a of authors) {
      const held = [...(r.collapsed.get(a) ?? []), ...out.newlyCollapsed.filter((it) => it.msg.author_id === a)];
      out.collapsed.push({
        authorId: a,
        displayAtPost: held[held.length - 1].msg.author_name_at_post,
        count: held.length,
        chars: held.reduce((n, it) => n + messageChars(it.msg), 0),
      });
    }
    out.backlog = r.backlog.length + out.newBacklog.length;
    return out;
  }

  commit(plan: ChunkPlan, now: number): void {
    const r = this.rooms.get(plan.roomId);
    if (!r || plan.reason === 'recheck') return;
    if (plan.reason === 'expand') r.expandQueue.splice(0, plan.expandTaken);
    else r.pending.splice(0, plan.consumed);
    for (const [a, chars] of plan.charges) {
      const list = r.delivered.get(a) ?? [];
      list.push({ at: now, chars });
      r.delivered.set(a, list);
    }
    for (const it of plan.newlyCollapsed) {
      const list = r.collapsed.get(it.msg.author_id) ?? [];
      list.push(it);
      r.collapsed.set(it.msg.author_id, list);
    }
    r.backlog.push(...plan.newBacklog);
    for (const it of plan.deliver) {
      if (it.kind !== 'message') continue;
      capSet(r.consumedIds, it.msg.id);
      this.pushRecent(r, it);
    }
    if (plan.reason !== 'expand') {
      r.lastChunkAt = now;
      r.immediate = false;
      r.dirty = false;
      if (r.pending.length === 0) r.catchupPending = false;
    }
  }

  // The model's own choice to read a collapsed count (or the catch-up backlog
  // when authorId is omitted). Returns how many items were queued.
  expand(roomId: string, authorId: string | null): number {
    const r = this.rooms.get(roomId);
    if (!r) return 0;
    if (authorId === null) {
      const items = r.backlog.filter((it): it is MsgItem => it.kind === 'message');
      r.backlog = [];
      r.expandQueue.push(...items);
      return items.length;
    }
    const items = r.collapsed.get(authorId) ?? [];
    r.collapsed.delete(authorId);
    r.expandQueue.push(...items);
    return items.length;
  }

  // --- test / status helpers
  pendingCount(roomId: string): number {
    return this.rooms.get(roomId)?.pending.length ?? 0;
  }

  collapsedCount(roomId: string, authorId: string): number {
    return this.rooms.get(roomId)?.collapsed.get(authorId)?.length ?? 0;
  }

  isDirty(roomId: string): boolean {
    return this.rooms.get(roomId)?.dirty ?? false;
  }
}

// Present rhythm: identical repeated messages from one author collapse into
// one item with a repeat count before any model call.
function dedupe(items: BufItem[]): BufItem[] {
  const out: BufItem[] = [];
  const index = new Map<string, number>();
  for (const it of items) {
    if (it.kind === 'message' && it.msg.state === 'normal' && typeof it.msg.body === 'string') {
      const key = JSON.stringify([it.msg.author_id, it.msg.body]);
      const at = index.get(key);
      if (at !== undefined) {
        const prev = out[at] as MsgItem;
        out[at] = { ...prev, repeats: (prev.repeats ?? 1) + 1 };
        continue;
      }
      index.set(key, out.length);
    }
    out.push(it);
  }
  return out;
}
