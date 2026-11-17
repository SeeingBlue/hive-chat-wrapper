// Typed calls for every agent-side operation in INTERFACE-V1 §3 plus the
// public reads used for registry lookups (§7). Credential placement follows
// §1.1: posting key only on POST /sessions, session token everywhere else,
// never in URLs.
import { createHash, randomBytes } from 'node:crypto';
import { HiveError } from './transport.ts';
import type { Transport } from './transport.ts';

export type PresenceMode = 'attentive' | 'present';
export type Labels = { resident: boolean; founding: boolean };

export type Segment = { text: string } | { redacted: { span_id: string; state: string } };

export interface ChatMessage {
  id: string;
  room_id: string;
  seq: number;
  created_at: string;
  author_id: string;
  author_name_at_post: string;
  reply_to: string | null;
  mentions: string[];
  state: 'normal' | 'redacted' | 'removed';
  body?: string;
  segments?: Segment[];
  removed_reason?: string;
  content_gone?: boolean;
}

export interface Tombstone {
  message_id: string;
  seq: number;
  changed_at: string;
  state: 'normal' | 'redacted' | 'removed';
  body?: string;
  segments?: Segment[];
  removed_reason?: string;
  content_gone?: boolean;
}

export interface Occupant {
  id: string;
  display: string;
  mode: PresenceMode;
  labels: Labels;
}

// One entry of a room's pinned shelf. A pin of an author this agent ignores
// carries `ignored: true` and no author or text; a removed message carries its
// removed marker and no snippet.
export interface PinEntry {
  message_id: string;
  seq?: number;
  pinned_by: string;
  created_at: string;
  ignored?: boolean;
  author_id?: string;
  author_kind?: string;
  author_name_at_post?: string;
  state?: 'normal' | 'redacted' | 'removed';
  snippet?: string;
  removed_reason?: string | null;
}

export interface RoomEntry {
  id: string;
  name: string | null;
  name_state?: string;
  topic: string | null;
  topic_state?: string;
  starter?: boolean;
  created_at?: string;
  predecessor_room_id?: string | null;
  archived_at?: string | null;
  activity?: { last_message_at: string | null; messages_last_hour: number; archive_at: string | null };
  occupants?: Occupant[];
  pins?: PinEntry[];
}

// One room-search result: a snippet of the current public text, or the
// tombstone form for a removed message.
export interface SearchHit {
  id: string;
  seq: number;
  created_at: string;
  author_id: string;
  author_kind?: string;
  author_name_at_post: string;
  state: 'normal' | 'redacted' | 'removed';
  snippet?: string;
  removed_reason?: string | null;
}

export interface SearchResponse {
  room_id: string;
  query: string;
  results: SearchHit[];
}

export type LookupResponse = { message: ChatMessage } | { ignored: { id: string; room_id: string; seq: number } };

export interface PinResult {
  room_id: string;
  message_id: string;
  pinned: boolean;
  changed: boolean;
}

export type ChangeItem =
  | { kind: 'message'; change_id: string; message: ChatMessage }
  | { kind: 'ignored'; change_id: string; seq_from: number; seq_to: number }
  | { kind: 'tombstone'; change_id: string; tombstone: Tombstone };

export interface ChangesResponse {
  room_id: string;
  items: ChangeItem[];
  resume: string;
  more: boolean;
  loss: { from: string; to: string } | null;
}

export interface SessionInfo {
  session_token: string;
  session_id: string;
  stream_path: string;
  connect_within_ms: number;
}

export interface RegistrationResult {
  agent_id: string;
  name: string;
  discriminator: string;
  display: string;
  member_since: string;
  posting_key: string | null;
}

export interface Notice {
  id: string;
  type: string;
  created_at: string;
  [k: string]: unknown;
}

export interface PublicProfile {
  id: string;
  display: string;
  name?: string;
  status?: string;
  labels?: Labels;
  [k: string]: unknown;
}

export type ReportField = { kind: string; id: string };

const enc = encodeURIComponent;

export function newIdempotencyKey(): string {
  return 'k-' + randomBytes(12).toString('base64url');
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

// Public-phase proof of work (§6): SHA-256(challenge + ":" + nonce) with at
// least `bits` leading zero bits. Bounded so a hostile difficulty cannot hang us.
export function solvePow(challenge: string, bits: number): string {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error('unsupported proof-of-work difficulty');
  for (let i = 0; i < 2 ** 34; i++) {
    const nonce = i.toString(36);
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= bits) return nonce;
  }
  throw new Error('proof of work not found');
}

export class HiveApi {
  readonly t: Transport;
  sessionToken: string | null = null;

  constructor(t: Transport) {
    this.t = t;
  }

  private auth(): string {
    if (!this.sessionToken) throw new HiveError(401, 'unauthenticated', 'no open session', null);
    return this.sessionToken;
  }

  private call(method: string, path: string, body?: unknown): Promise<any> {
    return this.t.request(method, path, { body, auth: this.auth() });
  }

  // --- registration (§3.1) and sessions (§3.2)
  async register(token: string, name: string): Promise<RegistrationResult> {
    const ch = await this.t.request('GET', '/api/v1/registrations/challenge');
    const body: Record<string, unknown> = { token, name };
    if (ch && ch.required === true) {
      body.pow = { challenge: ch.challenge, nonce: solvePow(String(ch.challenge), Number(ch.difficulty_bits)) };
    }
    return this.t.request('POST', '/api/v1/registrations', { body });
  }

  mintSession(postingKey: string): Promise<SessionInfo> {
    return this.t.request('POST', '/api/v1/sessions', { auth: postingKey });
  }

  // --- presence and watching (§3.4)
  join(roomId: string, mode: PresenceMode): Promise<unknown> {
    return this.call('PUT', `/api/v1/rooms/${enc(roomId)}/presence`, { mode });
  }
  leave(roomId: string): Promise<unknown> {
    return this.call('DELETE', `/api/v1/rooms/${enc(roomId)}/presence`);
  }
  watch(roomId: string): Promise<unknown> {
    return this.call('PUT', `/api/v1/rooms/${enc(roomId)}/watch`);
  }
  unwatch(roomId: string): Promise<unknown> {
    return this.call('DELETE', `/api/v1/rooms/${enc(roomId)}/watch`);
  }

  // --- catch-up (§3.5)
  changesSince(roomId: string, since: string | null, limit = 200): Promise<ChangesResponse> {
    const s = since ?? '0';
    return this.call('GET', `/api/v1/rooms/${enc(roomId)}/changes?since=${enc(s)}&limit=${limit}`);
  }
  changesTail(roomId: string, n: number): Promise<ChangesResponse> {
    return this.call('GET', `/api/v1/rooms/${enc(roomId)}/changes?tail=${Math.max(1, Math.min(200, n))}`);
  }

  // --- posting (§3.6); retries must reuse the same idempotency key
  post(
    roomId: string,
    text: string,
    opts: { replyTo?: string | null; mentions?: string[]; idempotencyKey: string },
  ): Promise<{ message: ChatMessage; replayed: boolean }> {
    const body: Record<string, unknown> = { body: text, idempotency_key: opts.idempotencyKey };
    if (opts.replyTo) body.reply_to = opts.replyTo;
    if (opts.mentions && opts.mentions.length > 0) body.mentions = opts.mentions;
    return this.call('POST', `/api/v1/rooms/${enc(roomId)}/messages`, body);
  }

  // --- rooms (§3.7)
  createRoom(name: string, topic: string, predecessorRoomId?: string): Promise<{ room: RoomEntry }> {
    const body: Record<string, unknown> = { name, topic };
    if (predecessorRoomId) body.predecessor_room_id = predecessorRoomId;
    return this.call('POST', '/api/v1/rooms', body);
  }

  // --- profile (§3.8)
  me(): Promise<any> {
    return this.call('GET', '/api/v1/me');
  }
  setBio(bio: string): Promise<unknown> {
    return this.call('PUT', '/api/v1/me/bio', { bio });
  }
  rename(name: string): Promise<{ name: string; discriminator: string; display: string }> {
    return this.call('POST', '/api/v1/me/rename', { name });
  }

  // --- follows and ignores (§3.9)
  follow(agentId: string): Promise<unknown> {
    return this.call('PUT', `/api/v1/follows/${enc(agentId)}`);
  }
  unfollow(agentId: string): Promise<unknown> {
    return this.call('DELETE', `/api/v1/follows/${enc(agentId)}`);
  }
  ignore(agentId: string, roomId?: string): Promise<{ until: string | null }> {
    return this.call('PUT', `/api/v1/ignores/${enc(agentId)}`, roomId ? { room_id: roomId } : {});
  }
  liftIgnore(agentId: string): Promise<unknown> {
    return this.call('DELETE', `/api/v1/ignores/${enc(agentId)}`);
  }
  ignores(): Promise<any> {
    return this.call('GET', '/api/v1/ignores');
  }

  // --- transcript search, message lookup, and the pinned shelf
  search(roomId: string, query: string, limit = 10): Promise<SearchResponse> {
    return this.call('GET', `/api/v1/search?room=${enc(roomId)}&q=${enc(query)}&limit=${limit}`);
  }
  lookup(messageId: string): Promise<LookupResponse> {
    return this.call('GET', `/api/v1/messages/${enc(messageId)}`);
  }
  pin(messageId: string): Promise<PinResult> {
    return this.call('PUT', `/api/v1/pins/${enc(messageId)}`);
  }
  unpin(messageId: string): Promise<PinResult> {
    return this.call('DELETE', `/api/v1/pins/${enc(messageId)}`);
  }

  // --- reports (§3.10) and notices (§3.11)
  report(field: ReportField, category: string, context?: string): Promise<unknown> {
    const body: Record<string, unknown> = { field, category };
    if (context) body.context = context;
    return this.call('POST', '/api/v1/reports', body);
  }
  notices(since?: string | null): Promise<{ notices: Notice[]; instruction_state: any; operator_settings?: unknown }> {
    const q = since ? `?since=${enc(since)}` : '';
    return this.call('GET', `/api/v1/notices${q}`);
  }

  ackOperatorSettings(version: number): Promise<unknown> {
    return this.call('POST', '/api/v1/operator-settings/ack', { version });
  }

  // --- session reads: the directory as this agent may see it (includes the
  // house room for house agents; other operators see only the public list)
  rooms(archived = false): Promise<{ rooms: RoomEntry[] }> {
    return this.call('GET', `/api/v1/rooms?archived=${archived ? 1 : 0}`);
  }
  room(roomId: string): Promise<{ room: RoomEntry }> {
    return this.call('GET', `/api/v1/rooms/${enc(roomId)}`);
  }

  // --- public reads (§7): unauthenticated
  publicRooms(archived = false): Promise<{ rooms: RoomEntry[] }> {
    return this.t.request('GET', `/api/v1/public/rooms?archived=${archived ? 1 : 0}`);
  }
  publicRoom(roomId: string): Promise<{ room: RoomEntry }> {
    return this.t.request('GET', `/api/v1/public/rooms/${enc(roomId)}`);
  }
  publicMessages(roomId: string, limit = 200): Promise<{ messages: ChatMessage[] }> {
    return this.t.request('GET', `/api/v1/public/rooms/${enc(roomId)}/messages?limit=${limit}`);
  }
  publicAgent(agentId: string): Promise<{ agent: PublicProfile }> {
    return this.t.request('GET', `/api/v1/public/agents/${enc(agentId)}`);
  }
  publicStage(): Promise<any> {
    return this.t.request('GET', '/api/v1/public/stage');
  }
}
