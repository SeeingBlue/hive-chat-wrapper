// Connection and session handling (Design §7.2, §7.5; INTERFACE-V1 §3.2-3.5).
//
// SessionManager: mint a session with the posting key, connect the stream,
// reconnect with backoff. Close 4001 (superseded): reconnect at most once per
// run; a second supersede stops and alerts the operator. 4003 (credentials
// changed): one new mint, and a 401 on it stops. 401 on mint, 4004 (retired):
// stop. 4007 (lagging): reconnect and
// resync via catch-up. 403/409 refusals are never treated as throttles.
//
// RoomSync: subscribe-then-catch-up. Live frames for a room being caught up are
// buffered, then drained with message-ID / change-ID de-duplication. The
// per-room cursor only advances to a `resume` after every item of that page
// was applied (or to the change_id of an applied in-order live frame).
import { connectWs } from './ws-client.ts';
import type { WsConnection } from './ws-client.ts';
import { HiveError } from './transport.ts';
import type { HiveApi, ChatMessage, Tombstone, ChangesResponse } from './protocol.ts';
import type { KeyStore } from './keystore.ts';
import { backoffMs, errText } from './util.ts';
import type { LogFn } from './util.ts';

export interface SessionHooks {
  connected(hello: Record<string, unknown>): void;
  frame(obj: Record<string, unknown>): void;
  disconnected(code: number, reason: string): void;
  fatal(reason: string, detail: string): void;
}

export class SessionManager {
  private readonly api: HiveApi;
  private readonly keys: KeyStore;
  private readonly hooks: SessionHooks;
  private readonly log: LogFn;
  private ws: WsConnection | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private connecting = false;
  supersededCount = 0;
  connected = false;

  constructor(api: HiveApi, keys: KeyStore, hooks: SessionHooks, log: LogFn) {
    this.api = api;
    this.keys = keys;
    this.hooks = hooks;
    this.log = log;
  }

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) this.ws.close(1000, 'client stopping');
  }

  // Drops the current stream so a fresh session is minted, e.g. after a
  // session-bound call answered 401 (the server already ended the session).
  forceReconnect(): void {
    if (this.stopped) return;
    if (this.ws) this.ws.close(1000, 'reconnecting');
    else this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connectOnce();
    }, ms);
    this.timer.unref();
  }

  private retryLater(): void {
    this.schedule(backoffMs(this.attempt++));
  }

  private fail(reason: string, detail: string): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hooks.fatal(reason, detail);
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      let key: string | null;
      try {
        key = this.keys.readPostingKey();
      } catch (e) {
        this.fail('posting_key_unreadable', errText(e));
        return;
      }
      if (!key) {
        this.fail('posting_key_missing', 'no posting key in the key store; run register, or import-key after the agent operator rotates it');
        return;
      }
      let info;
      try {
        info = await this.api.mintSession(key);
      } catch (e) {
        if (e instanceof HiveError) {
          if (e.status === 401) {
            this.fail('posting_key_rejected', 'the platform rejected the posting key (rotated, revoked or replaced); the agent operator must rotate it and run import-key');
            return;
          }
          if (e.code === 'retired') {
            this.fail('retired', 'this agent ID is retired');
            return;
          }
          if (e.isThrottle) {
            this.schedule(Math.max(1000, Math.min(e.retryAfterMs ?? 5000, 300_000)));
            return;
          }
          if (!e.isNetwork && e.status >= 400 && e.status < 500) {
            this.fail('mint_refused', `session mint refused: ${e.status} ${e.code}`);
            return;
          }
        }
        this.log('warn', `session mint failed: ${errText(e)}`);
        this.retryLater();
        return;
      }
      if (this.stopped) return;
      let ws: WsConnection;
      try {
        ws = await connectWs(this.api.t, info.stream_path || '/api/v1/stream', info.session_token);
      } catch (e) {
        this.log('warn', `stream connect failed: ${errText(e)}`);
        this.retryLater();
        return;
      }
      if (this.stopped) {
        ws.close(1000, 'client stopping');
        return;
      }
      this.api.sessionToken = info.session_token;
      this.ws = ws;
      ws.on('json', (obj: unknown) => this.onJson(ws, obj));
      ws.on('close', (code: number, reason: string) => this.onClose(ws, code, reason));
      ws.start();
    } finally {
      this.connecting = false;
    }
  }

  private onJson(ws: WsConnection, obj: unknown): void {
    if (ws !== this.ws || !obj || typeof obj !== 'object') return;
    const f = obj as Record<string, unknown>;
    if (f.type === 'hello') {
      this.connected = true;
      this.attempt = 0;
      this.hooks.connected(f);
      return;
    }
    this.hooks.frame(f);
  }

  private onClose(ws: WsConnection, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.connected = false;
    this.api.sessionToken = null;
    this.hooks.disconnected(code, reason);
    if (this.stopped) return;
    if (code === 4001) {
      this.supersededCount++;
      if (this.supersededCount >= 2) {
        this.fail('superseded_twice', 'superseded again after one reconnect: another harness is using this posting key; staying offline. If that harness is not yours, the agent operator should rotate the posting key.');
        return;
      }
      this.log('warn', 'session superseded (4001); reconnecting once');
      this.schedule(0);
      return;
    }
    if (code === 4003) {
      // Credentials changed. A leaked *session* token also closes with 4003
      // while the posting key stays valid, so try one mint: a 401 on that
      // mint is the fatal case (rotated/revoked key, completed reclaim).
      this.log('warn', 'credentials changed (4003); checking the posting key with one new session');
      this.schedule(0);
      return;
    }
    if (code === 4004) {
      this.fail('retired', 'this agent ID is retired');
      return;
    }
    // 4002 ping timeout, 4005 session invalid, 4006 restore, 4007 lagging,
    // 1001 going away, 1006 lost: mint a new session and resync via catch-up.
    this.log('info', `stream closed (${code}${reason ? ' ' + reason : ''}); reconnecting`);
    this.retryLater();
  }
}

export interface SyncSink {
  message(roomId: string, changeId: string, msg: ChatMessage, catchup: boolean): void;
  ignored(roomId: string, changeId: string, seqFrom: number, seqTo: number, catchup: boolean): void;
  tombstone(roomId: string, t: Tombstone): void;
  resetForTail(roomId: string): void;
  loss(roomId: string, loss: { from: string; to: string }): void;
}

export interface SyncOptions {
  tailSize: number;
  awayTailThresholdMs: number;
  digestMaxAgeMs: number;
}

export interface CursorRecord {
  cursor: string;
  at: number; // when this room was last known fully synced
}

const SEEN_CAP = 5000;

export class RoomSync {
  readonly cursors: Record<string, CursorRecord>;
  private readonly tracked = new Set<string>();
  private readonly queues = new Map<string, Array<Record<string, unknown>>>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly unsynced = new Set<string>();
  private readonly sink: SyncSink;
  private readonly opts: SyncOptions;
  private readonly now: () => number;

  constructor(cursors: Record<string, CursorRecord>, sink: SyncSink, opts: SyncOptions, now: () => number = Date.now) {
    this.cursors = cursors;
    this.sink = sink;
    this.opts = opts;
    this.now = now;
  }

  // Call before joining: live frames for the room are buffered until catchUp() drains them.
  begin(roomId: string): void {
    this.tracked.add(roomId);
    this.queues.set(roomId, []);
  }

  abort(roomId: string): void {
    this.tracked.delete(roomId);
    this.queues.delete(roomId);
  }

  // Left the room: if it was live and synced, it was synced until now.
  untrack(roomId: string): void {
    const c = this.cursors[roomId];
    if (c && this.tracked.has(roomId) && !this.unsynced.has(roomId) && !this.queues.has(roomId)) c.at = this.now();
    this.abort(roomId);
  }

  // Session ended: we were live until now in every synced room.
  disconnected(now: number): void {
    for (const room of this.tracked) {
      const c = this.cursors[room];
      if (c && !this.unsynced.has(room) && !this.queues.has(room)) c.at = now;
    }
    this.tracked.clear();
    this.queues.clear();
  }

  onLive(f: Record<string, unknown>): void {
    const roomId = typeof f.room_id === 'string' ? f.room_id : '';
    if (!this.tracked.has(roomId)) return;
    const q = this.queues.get(roomId);
    if (q) {
      q.push(f);
      return;
    }
    this.apply(roomId, f, false);
  }

  private seenSet(roomId: string): Set<string> {
    let s = this.seen.get(roomId);
    if (!s) {
      s = new Set();
      this.seen.set(roomId, s);
    }
    return s;
  }

  private apply(roomId: string, f: Record<string, unknown>, catchup: boolean): void {
    const kind = String(f.kind ?? f.type ?? '');
    const changeId = f.change_id === undefined || f.change_id === null ? '' : String(f.change_id);
    const seen = this.seenSet(roomId);
    const msg = kind === 'message' ? (f.message as ChatMessage | undefined) : undefined;
    const msgKey = msg && typeof msg.id === 'string' ? `m:${msg.id}` : null;
    const changeKey = changeId ? `c:${changeId}` : null;
    if ((msgKey && seen.has(msgKey)) || (changeKey && seen.has(changeKey))) return;
    if (kind === 'message' && msg) this.sink.message(roomId, changeId, msg, catchup);
    else if (kind === 'ignored') this.sink.ignored(roomId, changeId, Number(f.seq_from), Number(f.seq_to), catchup);
    else if (kind === 'tombstone' && f.tombstone) this.sink.tombstone(roomId, f.tombstone as Tombstone);
    else return;
    for (const k of [msgKey, changeKey]) {
      if (!k) continue;
      seen.add(k);
      if (seen.size > SEEN_CAP) {
        const first = seen.values().next().value;
        if (first !== undefined) seen.delete(first);
      }
    }
    if (!catchup && changeId && !this.unsynced.has(roomId)) this.cursors[roomId] = { cursor: changeId, at: this.now() };
  }

  private applyPage(roomId: string, res: ChangesResponse, cutoff: number | null): number {
    if (res.loss) this.sink.loss(roomId, res.loss);
    let n = 0;
    for (const it of res.items ?? []) {
      if (cutoff !== null && it.kind === 'message') {
        const t = Date.parse(it.message.created_at);
        if (Number.isFinite(t) && t < cutoff) continue; // older than the digest window
      }
      this.apply(roomId, it as unknown as Record<string, unknown>, true);
      n++;
    }
    return n;
  }

  // Reads the room's backlog after joining, recency-first when away long.
  // Returns how many items were applied.
  async catchUp(api: HiveApi, roomId: string, forceTail = false): Promise<number> {
    let applied = 0;
    let ok = false;
    try {
      const c = this.cursors[roomId];
      let useTail = forceTail || !c || this.now() - c.at > this.opts.awayTailThresholdMs;
      if (!useTail && c) {
        let since = c.cursor;
        for (;;) {
          const res = await api.changesSince(roomId, since, 200);
          applied += this.applyPage(roomId, res, null);
          since = res.resume;
          this.cursors[roomId] = { cursor: since, at: this.now() };
          if (!res.more) break;
          if (applied >= this.opts.tailSize) {
            useTail = true; // a large backlog is skimmed, not read in full
            break;
          }
        }
      }
      if (useTail) {
        this.sink.resetForTail(roomId);
        this.seen.delete(roomId);
        const res = await api.changesTail(roomId, this.opts.tailSize);
        applied = this.applyPage(roomId, res, this.now() - this.opts.digestMaxAgeMs);
        this.cursors[roomId] = { cursor: res.resume, at: this.now() };
      }
      ok = true;
      this.unsynced.delete(roomId);
    } finally {
      if (!ok) this.unsynced.add(roomId);
      const q = this.queues.get(roomId) ?? [];
      this.queues.delete(roomId);
      for (const f of q) this.apply(roomId, f, false);
    }
    return applied;
  }
}
