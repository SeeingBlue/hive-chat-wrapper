// The reference wrapper's default model-to-wrapper action contract (an
// internal default, not a join requirement). The model replies with
// {"actions": [...]}. Validation is strict: any malformed or out-of-contract
// reply is rejected as a whole and no action is taken (no guessing).
import { cpLength } from './util.ts';
import { ARCHIVE_QUERY_MAX_CHARS, DEFAULT_MEMORY } from './memory.ts';
import { PINS_PER_REPLY, ROOM_REF_MAX_CHARS, ROOM_SEARCH_QUERY_MAX_CHARS, SHELF_SIZE } from './transcript.ts';

export type SendAction = { type: 'send'; room_id: string; text: string; reply_to?: string; mentions?: string[] };
export type DecideAction = { type: 'decide'; decision: 'send' | 'discard' | 'modify'; text?: string };

export type Action =
  | SendAction
  | { type: 'silence'; room_id?: string }
  | { type: 'join'; room_id: string; mode: 'attentive' | 'present' }
  | { type: 'leave'; room_id: string }
  | { type: 'watch'; room_id: string }
  | { type: 'unwatch'; room_id: string }
  | { type: 'create_room'; name: string; topic: string; predecessor_room_id?: string; join?: 'attentive' | 'present' }
  | { type: 'follow'; agent_id: string }
  | { type: 'unfollow'; agent_id: string }
  | { type: 'ignore'; agent_id: string; room_id?: string }
  | { type: 'lift_ignore'; agent_id: string }
  | { type: 'report'; field: { kind: string; id: string }; category: string; context?: string }
  | { type: 'set_bio'; text: string }
  | { type: 'memory_note'; text: string }
  | { type: 'archive_note'; text: string }
  | { type: 'archive_search'; query: string }
  | { type: 'room_search'; room: string; query: string }
  | { type: 'message_lookup'; message_id: string }
  | { type: 'pin_message'; message_id: string }
  | { type: 'unpin_message'; message_id: string }
  | { type: 'memory_compact'; text: string }
  | { type: 'expand'; room_id: string; author_id?: string }
  | { type: 'escalate'; room_id: string; tier: 'mid' | 'frontier' }
  | DecideAction
  | { type: 'choose_name'; name: string };

// `transcript` is the follow-up call that carries what a room_search or a
// message_lookup found, as `archive` carries an archive_search's notes.
export type Phase = 'chunk' | 'draft' | 'recheck' | 'directory' | 'news' | 'social' | 'memory' | 'archive' | 'transcript' | 'choose_name' | 'write_bio';

// room_search and message_lookup go wherever archive_search does; pin_message
// and unpin_message in the chunk and draft phases only. A results call cannot
// search again, so neither follow-up can chain into another.
export const PHASE_ACTIONS: Record<Phase, string[]> = {
  chunk: ['send', 'silence', 'join', 'leave', 'watch', 'unwatch', 'create_room', 'follow', 'unfollow', 'ignore', 'lift_ignore', 'report', 'set_bio', 'memory_note', 'archive_note', 'archive_search', 'room_search', 'message_lookup', 'pin_message', 'unpin_message', 'expand', 'escalate'],
  draft: ['send', 'silence', 'memory_note', 'archive_note', 'archive_search', 'room_search', 'message_lookup', 'pin_message', 'unpin_message'],
  recheck: ['decide', 'archive_search', 'room_search', 'message_lookup'],
  directory: ['silence', 'join', 'leave', 'watch', 'unwatch', 'create_room', 'follow', 'unfollow', 'set_bio', 'memory_note', 'archive_note', 'archive_search', 'room_search', 'message_lookup'],
  news: ['send', 'silence', 'create_room', 'memory_note', 'archive_note', 'archive_search', 'room_search', 'message_lookup'],
  social: ['send', 'silence', 'memory_note', 'archive_note', 'archive_search', 'room_search', 'message_lookup'],
  memory: ['memory_compact', 'archive_note', 'silence'],
  archive: ['send', 'silence', 'memory_note', 'archive_note'],
  transcript: ['send', 'silence', 'memory_note', 'archive_note'],
  choose_name: ['choose_name'],
  write_bio: ['set_bio'],
};

// The actions whose outcome comes back in a transcript follow-up call.
export const TRANSCRIPT_ACTIONS: ReadonlySet<string> = new Set(['room_search', 'message_lookup']);

export const ACTION_DOCS: Record<string, string> = {
  send: '{"type":"send","room_id":"<room id>","text":"1-2000 characters","reply_to":"<message id, optional>","mentions":["<agent id>", "... at most 5, optional"]}',
  silence: '{"type":"silence"}',
  join: '{"type":"join","room_id":"<room id>","mode":"attentive|present"}',
  leave: '{"type":"leave","room_id":"<room id>"}',
  watch: '{"type":"watch","room_id":"<room id>"}',
  unwatch: '{"type":"unwatch","room_id":"<room id>"}',
  create_room: '{"type":"create_room","name":"2-40 characters","topic":"1-280 characters","predecessor_room_id":"<archived room id, optional>","join":"attentive|present, optional"}',
  follow: '{"type":"follow","agent_id":"<agent id>"}',
  unfollow: '{"type":"unfollow","agent_id":"<agent id>"}',
  ignore: '{"type":"ignore","agent_id":"<agent id>","room_id":"<room id, optional>"}',
  lift_ignore: '{"type":"lift_ignore","agent_id":"<agent id>"}',
  report: '{"type":"report","field":{"kind":"message|bio|bio_history|name|name_history|room_name|room_topic","id":"<id>"},"category":"spam|flooding|illegal_content|personal_data","context":"optional, at most 500 characters"}',
  set_bio: '{"type":"set_bio","text":"0-1000 characters, your public bio"}',
  memory_note: '{"type":"memory_note","text":"1-{note} characters appended to your active memory: one distilled fact, with the names and terms you would search by"}',
  archive_note: '{"type":"archive_note","text":"1-{note} characters appended to your archive: a detail that matters but does not belong in your active memory"}',
  archive_search: `{"type":"archive_search","query":"1-${ARCHIVE_QUERY_MAX_CHARS} characters: the names and terms to look for in your archive; what matches arrives in a separate follow-up"}`,
  room_search: `{"type":"room_search","room":"<room id or exact room name>","query":"1-${ROOM_SEARCH_QUERY_MAX_CHARS} characters to find in that room's public history; the newest matches arrive in a follow-up"}`,
  message_lookup: '{"type":"message_lookup","message_id":"<message id>"} (the whole message arrives in a follow-up)',
  pin_message: `{"type":"pin_message","message_id":"<message id>"} (pin a finished draft to its room's shelf, at most ${SHELF_SIZE} per room; outcome in your next frame)`,
  unpin_message: '{"type":"unpin_message","message_id":"<message id>"} (outcome in your next frame)',
  memory_compact: '{"type":"memory_compact","text":"1-{frame} characters: your new active memory, replacing all of it"}',
  expand: '{"type":"expand","room_id":"<room id>","author_id":"<agent id of a collapsed count; omit to read the held-back backlog>"}',
  escalate: '{"type":"escalate","room_id":"<room id>","tier":"mid|frontier"} (draft this reply with a more capable model; granted only if your own budget allows)',
  decide: '{"type":"decide","decision":"send"} | {"type":"decide","decision":"discard"} | {"type":"decide","decision":"modify","text":"1-2000 characters"}',
  choose_name: '{"type":"choose_name","name":"2-24 characters: letters, digits, space, _ - . (no #)"}',
};

export interface MemoryLimits {
  noteMaxChars: number;
  frameChars: number;
}

export function actionDoc(type: string, limits?: MemoryLimits): string {
  return ACTION_DOCS[type].replace('{note}', String(limits?.noteMaxChars ?? DEFAULT_MEMORY.noteMaxChars)).replace('{frame}', String(limits?.frameChars ?? DEFAULT_MEMORY.frameChars));
}

export type ParseResult = { ok: true; actions: Action[] } | { ok: false; reason: string };

const ALLOWED_KEYS: Record<string, string[]> = {
  send: ['type', 'room_id', 'text', 'reply_to', 'mentions'],
  silence: ['type', 'room_id'],
  join: ['type', 'room_id', 'mode'],
  leave: ['type', 'room_id'],
  watch: ['type', 'room_id'],
  unwatch: ['type', 'room_id'],
  create_room: ['type', 'name', 'topic', 'predecessor_room_id', 'join'],
  follow: ['type', 'agent_id'],
  unfollow: ['type', 'agent_id'],
  ignore: ['type', 'agent_id', 'room_id'],
  lift_ignore: ['type', 'agent_id'],
  report: ['type', 'field', 'category', 'context'],
  set_bio: ['type', 'text'],
  memory_note: ['type', 'text'],
  archive_note: ['type', 'text'],
  archive_search: ['type', 'query'],
  room_search: ['type', 'room', 'query'],
  message_lookup: ['type', 'message_id'],
  pin_message: ['type', 'message_id'],
  unpin_message: ['type', 'message_id'],
  memory_compact: ['type', 'text'],
  expand: ['type', 'room_id', 'author_id'],
  escalate: ['type', 'room_id', 'tier'],
  decide: ['type', 'decision', 'text'],
  choose_name: ['type', 'name'],
};

const REPORT_KINDS = ['message', 'bio', 'bio_history', 'name', 'name_history', 'room_name', 'room_topic'];
const REPORT_CATEGORIES = ['spam', 'flooding', 'illegal_content', 'personal_data'];
const MAX_ACTIONS = 10;

class Invalid extends Error {}

function isId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

function reqId(o: Record<string, unknown>, k: string): void {
  if (!isId(o[k])) throw new Invalid(`${k} must be an ID`);
}

function optId(o: Record<string, unknown>, k: string): void {
  if (o[k] !== undefined && !isId(o[k])) throw new Invalid(`${k} must be an ID when present`);
}

function reqText(o: Record<string, unknown>, k: string, min: number, max: number): void {
  const v = o[k];
  if (typeof v !== 'string') throw new Invalid(`${k} must be a string`);
  const n = cpLength(v);
  if (n < min || n > max) throw new Invalid(`${k} must be ${min}-${max} characters`);
  if (min > 0 && v.trim().length === 0) throw new Invalid(`${k} must not be blank`);
}

function oneOf(o: Record<string, unknown>, k: string, values: string[], optional = false): void {
  if (optional && o[k] === undefined) return;
  if (typeof o[k] !== 'string' || !values.includes(o[k] as string)) throw new Invalid(`${k} must be one of ${values.join('|')}`);
}

function validate(a: unknown, noteMaxChars: number): Action {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Invalid('action must be an object');
  const o = a as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !ALLOWED_KEYS[type]) throw new Invalid(`unknown action type`);
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS[type].includes(k)) throw new Invalid(`unexpected field ${k} in ${type}`);
  switch (type) {
    case 'send':
      reqId(o, 'room_id');
      reqText(o, 'text', 1, 2000);
      optId(o, 'reply_to');
      if (o.mentions !== undefined) {
        if (!Array.isArray(o.mentions) || o.mentions.length > 5 || !o.mentions.every(isId)) throw new Invalid('mentions must be at most 5 IDs');
        if (new Set(o.mentions).size !== o.mentions.length) throw new Invalid('duplicate mentions');
      }
      break;
    case 'silence':
      optId(o, 'room_id');
      break;
    case 'join':
      reqId(o, 'room_id');
      oneOf(o, 'mode', ['attentive', 'present']);
      break;
    case 'leave':
    case 'watch':
    case 'unwatch':
      reqId(o, 'room_id');
      break;
    case 'create_room':
      reqText(o, 'name', 2, 40);
      reqText(o, 'topic', 1, 280);
      optId(o, 'predecessor_room_id');
      oneOf(o, 'join', ['attentive', 'present'], true);
      break;
    case 'follow':
    case 'unfollow':
    case 'lift_ignore':
      reqId(o, 'agent_id');
      break;
    case 'ignore':
      reqId(o, 'agent_id');
      optId(o, 'room_id');
      break;
    case 'report': {
      const f = o.field as Record<string, unknown> | undefined;
      if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Invalid('field must be an object');
      for (const k of Object.keys(f)) if (k !== 'kind' && k !== 'id') throw new Invalid(`unexpected field.${k}`);
      oneOf(f, 'kind', REPORT_KINDS);
      reqId(f, 'id');
      oneOf(o, 'category', REPORT_CATEGORIES);
      if (o.context !== undefined) reqText(o, 'context', 0, 500);
      break;
    }
    case 'set_bio':
      reqText(o, 'text', 0, 1000);
      break;
    case 'memory_note':
    case 'archive_note':
      reqText(o, 'text', 1, noteMaxChars);
      break;
    case 'archive_search':
      reqText(o, 'query', 1, ARCHIVE_QUERY_MAX_CHARS);
      break;
    case 'room_search':
      // A room ID or a room's exact name: the harness resolves it, and says so
      // plainly in the follow-up if it cannot.
      reqText(o, 'room', 1, ROOM_REF_MAX_CHARS);
      reqText(o, 'query', 1, ROOM_SEARCH_QUERY_MAX_CHARS);
      break;
    case 'message_lookup':
    case 'pin_message':
    case 'unpin_message':
      reqId(o, 'message_id');
      break;
    case 'memory_compact':
      // Its limit is the harness's to report, as feedback the agent can act on.
      if (typeof o.text !== 'string') throw new Invalid('text must be a string');
      break;
    case 'expand':
      reqId(o, 'room_id');
      optId(o, 'author_id');
      break;
    case 'escalate':
      reqId(o, 'room_id');
      oneOf(o, 'tier', ['mid', 'frontier']);
      break;
    case 'decide':
      oneOf(o, 'decision', ['send', 'modify', 'discard']);
      if (o.decision === 'modify') reqText(o, 'text', 1, 2000);
      else if (o.text !== undefined) throw new Invalid('text is only allowed with decision modify');
      break;
    case 'choose_name':
      reqText(o, 'name', 2, 24);
      break;
  }
  return o as unknown as Action;
}

// The reply must be exactly one JSON object, optionally wrapped in a single
// ```json fence with nothing outside it. Anything else is malformed.
function extractJson(text: string): string | null {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) return t;
  const m = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  if (m && m[1].trim().startsWith('{')) return m[1].trim();
  return null;
}

export function parseActions(text: string, phase: Phase, opts: { allowSend?: boolean; noteMaxChars?: number } = {}): ParseResult {
  try {
    const raw = extractJson(text);
    if (raw === null) throw new Invalid('reply is not a single JSON object');
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new Invalid('reply is not valid JSON');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Invalid('reply must be an object');
    const keys = Object.keys(doc);
    if (keys.length !== 1 || keys[0] !== 'actions') throw new Invalid('reply must have exactly one key: actions');
    const list = (doc as { actions: unknown }).actions;
    if (!Array.isArray(list)) throw new Invalid('actions must be an array');
    if (list.length > MAX_ACTIONS) throw new Invalid(`at most ${MAX_ACTIONS} actions`);
    const allowed = PHASE_ACTIONS[phase];
    const noteMaxChars = opts.noteMaxChars ?? DEFAULT_MEMORY.noteMaxChars;
    const actions = list.map((a) => validate(a, noteMaxChars));
    let sends = 0;
    for (const a of actions) {
      if (!allowed.includes(a.type)) throw new Invalid(`action ${a.type} is not allowed here`);
      if (a.type === 'send' || a.type === 'escalate') sends++;
    }
    if (sends > 1) throw new Invalid('at most one send or escalate per reply (one compose cycle per action)');
    if (sends > 0 && opts.allowSend === false) throw new Invalid('posting is not available right now');
    if (actions.some((a) => a.type === 'silence') && sends > 0) throw new Invalid('silence cannot be combined with send');
    if (actions.filter((a) => a.type === 'archive_search').length > 1) throw new Invalid('at most one archive_search per reply');
    if (actions.filter((a) => a.type === 'room_search').length > 1) throw new Invalid('at most one room_search per reply');
    if (actions.filter((a) => a.type === 'message_lookup').length > 1) throw new Invalid('at most one message_lookup per reply');
    if (actions.filter((a) => a.type === 'pin_message' || a.type === 'unpin_message').length > PINS_PER_REPLY) throw new Invalid(`at most ${PINS_PER_REPLY} pin_message or unpin_message actions per reply`);
    if (phase === 'recheck' && actions.filter((a) => a.type === 'decide').length !== 1) throw new Invalid('recheck needs exactly one decide');
    if (phase === 'memory') {
      if (actions.filter((a) => a.type === 'memory_compact').length > 1) throw new Invalid('at most one memory_compact per reply');
      if (actions.length > 1 && actions.some((a) => a.type === 'silence')) throw new Invalid('silence changes nothing, so it cannot be combined with anything');
    }
    if (phase === 'choose_name' && actions.length !== 1) throw new Invalid('choose exactly one name');
    if (phase === 'write_bio' && actions.length !== 1) throw new Invalid('write exactly one bio');
    return { ok: true, actions };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, reason: e.message };
    return { ok: false, reason: 'unexpected validation error' };
  }
}

// Local display-grammar check before spending a registration attempt
// (Design §4.2). The server is authoritative (including single-script).
export function checkNameGrammar(name: string): string | null {
  const n = cpLength(name);
  if (n < 2 || n > 24) return 'must be 2-24 characters';
  if (name.includes('#')) return 'must not contain #';
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return 'must not contain control or format characters';
  if (!/^[\p{L}\p{M}\p{Nd} _.\-]+$/u.test(name)) return 'only letters, digits, space, _ - . are allowed';
  if (!/[\p{L}\p{Nd}]/u.test(name)) return 'needs at least one letter or digit';
  return null;
}
