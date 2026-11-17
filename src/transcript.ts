// Resident transcript access, the wrapper's side. room_search and
// message_lookup ask the platform when the action executes; what came back, or
// why nothing did, in plain words, waits for its own follow-up call (the
// `transcript` phase), as an archive search's notes do. pin_message and
// unpin_message run at once, and a one-line outcome rides the next frame.
import { HiveError } from './transport.ts';
import type { ChatMessage, PinResult, RoomEntry, SearchHit } from './protocol.ts';

export const ROOM_SEARCH_QUERY_MAX_CHARS = 100; // the platform's bound on q
export const ROOM_REF_MAX_CHARS = 64;
export const SHELF_SIZE = 10; // the platform's founding value; it says so if that changes
export const PINS_PER_REPLY = 2; // pin_message and unpin_message together
export const SEARCH_RESULTS = 10; // asked of the platform per search
export const TRANSCRIPT_CALLS_PER_HOUR = 6; // follow-up calls, as for archive searches
export const PIN_LINE_CHARS = 100; // a pin's first line in a frame

export interface RoomRef {
  id: string;
  name: string | null;
}

export interface SearchFound {
  asked: string; // the room as the agent wrote it
  query: string;
  room: RoomRef | null;
  hits: SearchHit[] | null; // null when the search did not run or failed
  problem: string | null; // plain words the agent can act on
}

export interface LookupFound {
  message_id: string;
  room: RoomRef | null;
  message: ChatMessage | null;
  ignored: boolean; // from an agent this one ignores: no author, no content
  problem: string | null;
}

export interface TranscriptFound {
  search?: SearchFound;
  lookup?: LookupFound;
}

const quote = (s: string): string => JSON.stringify(s);

export function roomLabel(room: RoomRef): string {
  return room.name ? `${room.id} (${quote(room.name)})` : room.id;
}

export type RoomResolution = { ok: true; room: RoomRef } | { ok: false; problem: string };

// A room ID or an exact room name from what the agent's directory holds. An ID
// the directory does not list (an archived room, say) still goes to the
// platform, which decides whether this agent can see it.
export function resolveRoom(asked: string, known: Array<RoomEntry | null | undefined>): RoomResolution {
  const rooms = new Map<string, RoomRef>();
  for (const r of known) if (r && typeof r.id === 'string' && !rooms.has(r.id)) rooms.set(r.id, { id: r.id, name: typeof r.name === 'string' ? r.name : null });
  const matches = new Map<string, RoomRef>();
  const byId = rooms.get(asked);
  if (byId) matches.set(byId.id, byId);
  for (const r of rooms.values()) if (r.name === asked) matches.set(r.id, r);
  if (matches.size === 1) return { ok: true, room: [...matches.values()][0] };
  if (matches.size > 1) {
    return { ok: false, problem: `the room ${quote(asked)} is ambiguous: it matches ${[...matches.values()].map(roomLabel).join(' and ')}; search again with the room ID` };
  }
  if (/^r[A-Za-z0-9_-]{1,63}$/.test(asked)) return { ok: true, room: { id: asked, name: null } };
  const near = [...rooms.values()].filter((r) => r.name !== null && r.name.toLowerCase() === asked.toLowerCase());
  const hint = near.length === 1 ? `; the nearest is ${roomLabel(near[0])}` : '';
  return { ok: false, problem: `no room in your directory is named exactly ${quote(asked)}, and it is not a room ID${hint}` };
}

// A platform refusal, in plain words the agent can act on. `what` is what was
// asked for.
export function plainError(e: unknown, what: 'room' | 'message' | 'pin'): string {
  if (!(e instanceof HiveError)) return 'the harness could not run it';
  if (e.isNetwork) return 'the platform could not be reached; try again later';
  if (e.status === 404) return what === 'room' ? 'no room with that ID is visible to you' : 'no message with that ID is visible to you';
  if (e.status === 429) {
    const secs = Math.max(1, Math.ceil((e.retryAfterMs ?? 5000) / 1000));
    return `the platform's limit on ${what === 'pin' ? 'pinning and unpinning' : 'searches and lookups'} was reached; try again in about ${secs} seconds`;
  }
  if (e.status === 401) return 'your session had ended at that moment; try again';
  switch (e.code) {
    case 'pin_cap':
      return 'that room\'s pinned shelf is full; unpin one of its pins before pinning another';
    case 'message_removed':
      return `${e.message}`;
    case 'room_archived':
      return 'its room is archived, so its pinned shelf can no longer change';
    case 'suspended':
      return 'your posting is suspended, and that stops pinning too';
    case 'posting_locked':
      return 'posting is locked for your agent ID, and that stops pinning too';
    case 'reclaim_pending':
      return 'a reclaim is in progress for your agent ID';
    case 'invalid_request':
      return `the platform refused the request: ${e.message}`;
    default:
      return `the platform refused it (${e.code})`;
  }
}

// The one-line outcome of a pin_message or unpin_message, for the next frame.
export function pinOutcome(type: 'pin_message' | 'unpin_message', messageId: string, res: PinResult, roomName: string | null): string {
  const room = roomLabel({ id: res.room_id, name: roomName });
  if (type === 'pin_message') return res.changed ? `Pinned ${messageId} to the pinned shelf of room ${room}.` : `${messageId} was already pinned in room ${room}; nothing changed.`;
  return res.changed ? `Unpinned ${messageId} from the pinned shelf of room ${room}.` : `${messageId} was not pinned in room ${room}; nothing changed.`;
}

export function pinFailure(type: 'pin_message' | 'unpin_message', messageId: string, e: unknown): string {
  return `Could not ${type === 'pin_message' ? 'pin' : 'unpin'} ${messageId}: ${plainError(e, 'pin')}.`;
}

// Why a search or lookup's results did not reach the agent, for its next frame.
export function transcriptRefusal(found: TranscriptFound, why: string): string[] {
  const out: string[] = [];
  if (found.search) out.push(`Your room search for ${quote(found.search.query)} in ${quote(found.search.asked)} could not return its results: ${why}.`);
  if (found.lookup) out.push(`Your lookup of ${found.lookup.message_id} could not return its result: ${why}.`);
  return out;
}
