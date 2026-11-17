// Model cycles: chunk consumption, the §3.6 compose cycle (draft → recheck →
// send/modify/discard), escalation, directory review. One compose cycle is
// one action: the instruction state in force when it starts applies to the
// whole cycle; a state received mid-cycle applies at the next action, and a
// backend that keeps context starts a fresh session before that action.
//
// Every model call asks the governor's hard gate and is reserved through the
// governor before it starts. A chunk cycle reserves its listening call plus the
// bounded recheck up front, so a hard-cap cycle admitted under the completion
// promise can always finish.
import { AdapterError } from './adapters/types.ts';
import type { CallResult, ModelAdapter, Tier } from './adapters/types.ts';
import type { CallKind, Governor, Reservation } from './governor.ts';
import type { Listener, ChunkPlan, ChunkReason } from './listener.ts';
import type { Registry } from './registry.ts';
import type { RoomEntry } from './protocol.ts';
import { parseActions, TRANSCRIPT_ACTIONS } from './actions.ts';
import type { Action, DecideAction, Phase, SendAction } from './actions.ts';
import { SYSTEM_PREAMBLE, reviewFingerprint } from './frame.ts';
import type { ArchiveFound, InstructionValue, MemoryReviewView, NewsForm } from './frame.ts';
import type { TranscriptFound } from './transcript.ts';
import type { SocialDue } from './social.ts';
import { errText } from './util.ts';
import type { LogFn } from './util.ts';

export const CHUNK_MAX_BYTES = 160_000;
export const RECHECK_MAX_BYTES = 48_000;
const SYSTEM_BYTES = Buffer.byteLength(SYSTEM_PREAMBLE, 'utf8');

export type CycleOutcome = 'done' | 'empty' | 'no_budget' | 'failed' | 'rejected' | 'unchanged';

export interface FrameOpts {
  roomId?: string;
  plan?: ChunkPlan;
  draft?: SendAction;
  directory?: RoomEntry[];
  news?: string[];
  newsForm?: NewsForm;
  social?: SocialDue;
  memoryReview?: MemoryReviewView;
  archive?: ArchiveFound;
  transcript?: TranscriptFound;
  maxBytes?: number;
}

export interface CycleHost {
  adapter: ModelAdapter;
  governor: Governor;
  listener: Listener;
  registry: Registry;
  log: LogFn;
  maxOut: { listen: number; mid: number; frontier: number; recheck: number };
  now(): number;
  beginAction(): InstructionValue | null;
  frame(task: Phase, instr: InstructionValue | null, opts: FrameOpts): string;
  postingAllowed(): boolean;
  presentIn(roomId: string): boolean;
  execute(actions: Action[], roomId: string | null): Promise<void>;
  post(roomId: string, send: SendAction): Promise<boolean>;
  canEscalate(tier: Tier): boolean;
  noteEscalation(tier: Tier): void;
  rejected(reason: string, phase: Phase): void;
  fatal(reason: string, detail: string): void;
  listDirectory(): Promise<RoomEntry[] | null>;
  reviewedFingerprint(): string | null; // what the last review that ran was given
  noteReviewed(fingerprint: string): void;
  noteCallStarting?(prompt: string): void; // this frame is going to the model now
  noteMaxChars?(): number; // the limit on one note, when it is not the default
  feedback?(text: string): void; // goes to the agent with its next call
}

function sameInstr(a: InstructionValue | null, b: InstructionValue | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.text === b.text && a.timetable === b.timetable;
}

export function toInstruction(v: unknown): InstructionValue | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.state !== 'F1' && o.state !== 'F2') return null;
  return {
    state: o.state,
    text: typeof o.text === 'string' ? o.text : null,
    timetable: typeof o.timetable === 'string' ? o.timetable : null,
  };
}

export class InstructionTracker {
  current: InstructionValue | null = null;
  private pending: InstructionValue | null = null;
  private hasPending = false;

  // Delivered state (notice frame or session start); applied at the next action.
  set(v: InstructionValue | null): void {
    this.pending = v;
    this.hasPending = true;
  }

  begin(adapter: ModelAdapter): InstructionValue | null {
    if (this.hasPending) {
      const changed = !sameInstr(this.current, this.pending);
      this.current = this.pending;
      this.pending = null;
      this.hasPending = false;
      if (changed && adapter.resetSession) adapter.resetSession();
    }
    return this.current;
  }
}

export function callBytes(prompt: string): number {
  return SYSTEM_BYTES + Buffer.byteLength(prompt, 'utf8');
}

// CLIs that take the prompt as an argument have a lower ceiling than the default.
function chunkMaxBytes(h: CycleHost): number {
  return h.adapter.maxCallBytes === undefined ? CHUNK_MAX_BYTES : Math.min(CHUNK_MAX_BYTES, h.adapter.maxCallBytes - SYSTEM_BYTES);
}

function costOf(h: CycleHost, tier: Tier, inputBytes: number, maxOutputTokens: number): number {
  return h.governor.amountOf(h.adapter.maxCost({ tier, inputBytes, maxOutputTokens }));
}

export function recheckCost(h: CycleHost): number {
  return costOf(h, 'listen', SYSTEM_BYTES + RECHECK_MAX_BYTES, h.maxOut.recheck);
}

// The smallest listening action the wrapper takes: a small chunk plus its recheck.
export function minListenCost(h: CycleHost): number {
  return costOf(h, 'listen', SYSTEM_BYTES + 4096, h.maxOut.listen) + recheckCost(h);
}

function admitted(h: CycleHost, kind: CallKind): boolean {
  return h.governor.admits(kind, minListenCost(h));
}

export async function callModel(h: CycleHost, res: Reservation, prompt: string, tier: Tier, maxOutputTokens: number, escalated: boolean): Promise<CallResult | null> {
  try {
    h.noteCallStarting?.(prompt);
    const r = await h.adapter.call(prompt, { tier, maxOutputTokens, system: SYSTEM_PREAMBLE });
    h.governor.settle(res, h.governor.amountOf(r.usage), escalated);
    h.governor.noteSuccess();
    return r;
  } catch (e) {
    if (e instanceof AdapterError) {
      if (e.usage) h.governor.settle(res, h.governor.amountOf(e.usage), escalated);
      if (e.kind === 'violation') {
        h.fatal('tool_use_violation', `backend broke the tool-free rule: ${e.message}`);
        return null;
      }
      if (e.kind === 'vendor_limit') {
        h.governor.noteVendorLimit(e.retryAfterMs);
        h.log('warn', 'model vendor limit reached; stepping down until it clears');
        return null;
      }
    }
    h.governor.noteFailure();
    h.log('warn', `model call failed: ${errText(e)}`);
    return null;
  }
}

function sendIn(actions: Action[]): SendAction | null {
  for (const a of actions) if (a.type === 'send') return a;
  return null;
}

function parse(h: CycleHost, text: string, phase: Phase, allowSend?: boolean) {
  return parseActions(text, phase, { allowSend, noteMaxChars: h.noteMaxChars?.() });
}

function sideActions(actions: Action[]): Action[] {
  return actions.filter((a) => a.type !== 'send' && a.type !== 'escalate' && a.type !== 'silence');
}

// Consume one chunk of a room's buffer.
export async function runChunkCycle(h: CycleHost, roomId: string, reason: ChunkReason): Promise<CycleOutcome> {
  // Expanded items were already offered once, so they are not new room content.
  if (!admitted(h, reason === 'expand' ? 'expand' : 'room_content')) return 'no_budget';
  const instr = h.beginAction();
  await h.registry.ensure(h.listener.pendingAuthors(roomId));
  const now = h.now();
  const plan = h.listener.plan(roomId, now, reason);
  if (!plan) return 'empty';
  // Nothing readable (only collapsed counts or ignored runs): no model call.
  if (!plan.deliver.some((it) => it.kind === 'message')) {
    h.listener.commit(plan, now);
    return 'empty';
  }
  const prompt = h.frame('chunk', instr, { roomId, plan, maxBytes: chunkMaxBytes(h) });
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), h.maxOut.listen) + recheckCost(h), 0);
  if (!res) return 'no_budget'; // the call does not start; the buffer is untouched
  h.listener.commit(plan, now);
  try {
    const out = await callModel(h, res, prompt, 'listen', h.maxOut.listen, false);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'chunk', h.postingAllowed());
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'chunk');
      return 'rejected';
    }
    const send = sendIn(parsed.actions);
    const esc = parsed.actions.find((a) => a.type === 'escalate');
    if ((send && send.room_id !== roomId) || (esc && esc.type === 'escalate' && esc.room_id !== roomId)) {
      h.rejected('send/escalate must target the room of this chunk', 'chunk');
      return 'rejected';
    }
    await h.execute(sideActions(parsed.actions), roomId);
    if (send) {
      await recheckAndSend(h, res, roomId, send, instr);
      return 'done';
    }
    if (esc && esc.type === 'escalate') {
      h.governor.release(res);
      return await runEscalatedDraft(h, roomId, esc.tier, plan, instr);
    }
    return 'done';
  } finally {
    h.governor.release(res);
  }
}

// Escalation is the harness's own decision (requested by its listening model),
// limited by the escalation sub-budget and a per-hour count; chat text cannot
// raise either.
async function runEscalatedDraft(h: CycleHost, roomId: string, tier: Tier, plan: ChunkPlan, instr: InstructionValue | null): Promise<CycleOutcome> {
  if (!h.postingAllowed() || !h.canEscalate(tier) || !admitted(h, 'escalation')) {
    h.log('info', `escalation to ${tier} declined (limit, budget tier, or not available)`);
    return 'done';
  }
  const prompt = h.frame('draft', instr, { roomId, plan, maxBytes: chunkMaxBytes(h) });
  const draftCost = costOf(h, tier, callBytes(prompt), h.maxOut[tier]);
  const res = h.governor.reserve(draftCost + recheckCost(h), draftCost);
  if (!res) {
    h.log('info', `escalation to ${tier} does not fit the budget or the escalation sub-budget`);
    return 'no_budget';
  }
  h.noteEscalation(tier);
  try {
    const out = await callModel(h, res, prompt, tier, h.maxOut[tier], true);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'draft', h.postingAllowed());
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'draft');
      return 'rejected';
    }
    const send = sendIn(parsed.actions);
    if (send && send.room_id !== roomId) {
      h.rejected('send must target the room of this draft', 'draft');
      return 'rejected';
    }
    await h.execute(sideActions(parsed.actions), roomId);
    if (send) await recheckAndSend(h, res, roomId, send, instr);
    return 'done';
  } finally {
    h.governor.release(res);
  }
}

// §3.6 step 2: recheck everything that arrived while drafting, cheaply.
async function recheckAndSend(h: CycleHost, res: Reservation, roomId: string, send: SendAction, instr: InstructionValue | null): Promise<void> {
  await h.registry.ensure(h.listener.pendingAuthors(roomId));
  const view = h.listener.plan(roomId, h.now(), 'recheck');
  let text = send.text;
  if (view && view.deliver.some((it) => it.kind === 'message')) {
    const prompt = h.frame('recheck', instr, { roomId, plan: view, draft: send, maxBytes: RECHECK_MAX_BYTES });
    if (Buffer.byteLength(prompt, 'utf8') > RECHECK_MAX_BYTES) {
      h.log('warn', 'recheck frame over its reserved bound; draft discarded');
      return;
    }
    if (!h.governor.mayContinue(res, recheckCost(h))) {
      h.log('info', `draft for ${roomId} discarded: its recheck may not start at this budget`);
      return; // no recheck, no send: silence is safe
    }
    const out = await callModel(h, res, prompt, 'listen', h.maxOut.recheck, false);
    if (!out) return; // no recheck, no send: silence is safe
    const parsed = parseActions(out.text, 'recheck');
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'recheck');
      return;
    }
    await h.execute(parsed.actions.filter((a) => a.type === 'archive_search' || TRANSCRIPT_ACTIONS.has(a.type)), roomId);
    const d = parsed.actions.find((a) => a.type === 'decide') as DecideAction;
    if (d.decision === 'discard') {
      h.log('info', `draft for ${roomId} discarded at recheck`);
      return;
    }
    if (d.decision === 'modify' && typeof d.text === 'string') text = d.text;
  }
  if (!h.postingAllowed()) return;
  await h.post(roomId, { ...send, text });
}

// Room choice: the agent decides where to be (Principle 2). The same inputs would
// get the same answer, so a review only runs when they differ from those of the
// last review that ran. One that failed or was rejected does not count as run.
export async function runDirectoryCycle(h: CycleHost): Promise<CycleOutcome> {
  if (!admitted(h, 'directory')) return 'no_budget';
  const instr = h.beginAction();
  const rooms = await h.listDirectory();
  if (!rooms) return 'failed';
  const prompt = h.frame('directory', instr, { directory: rooms, maxBytes: chunkMaxBytes(h) });
  const fingerprint = reviewFingerprint(prompt);
  if (fingerprint === h.reviewedFingerprint()) {
    h.log('info', 'directory review skipped: directory unchanged');
    return 'unchanged';
  }
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), h.maxOut.listen), 0);
  if (!res) return 'no_budget';
  try {
    const out = await callModel(h, res, prompt, 'listen', h.maxOut.listen, false);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'directory');
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'directory');
      return 'rejected';
    }
    h.noteReviewed(fingerprint);
    await h.execute(sideActions(parsed.actions), null);
    return 'done';
  } finally {
    h.governor.release(res);
  }
}

// The resident news spark: one listening call for the new stories of one fetch,
// tied to no room, so the agent chooses where to post. In full form it carries the
// article text the stories are still owed. In headline form, the one admitted at
// the present tier, it carries headlines and sources only, so it is smaller and
// reserved as such, and it uses up no story's one full-text delivery. A send still
// goes through the §3.6 recheck, reserved up front as in a chunk cycle. On
// 'no_budget' no call started, and the caller keeps the stories pending; on any
// other outcome the caller has given them up: nothing here is retried.
export async function runNewsCycle(h: CycleHost, headlines: string[], form: NewsForm = 'full'): Promise<CycleOutcome> {
  if (!h.postingAllowed()) return 'empty'; // nothing the call could share
  if (!admitted(h, form === 'headline' ? 'news_headline' : 'news')) return 'no_budget';
  const instr = h.beginAction();
  const prompt = h.frame('news', instr, { news: headlines, newsForm: form, maxBytes: chunkMaxBytes(h) });
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), h.maxOut.listen) + recheckCost(h), 0);
  if (!res) return 'no_budget';
  try {
    const out = await callModel(h, res, prompt, 'listen', h.maxOut.listen, false);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'news', h.postingAllowed());
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'news');
      return 'rejected';
    }
    const send = sendIn(parsed.actions);
    if (send && !h.presentIn(send.room_id)) {
      h.rejected('send must target a room you are present in', 'news');
      return 'rejected';
    }
    await h.execute(sideActions(parsed.actions), null);
    if (send) await recheckAndSend(h, res, send.room_id, send, instr);
    return 'done';
  } finally {
    h.governor.release(res);
  }
}

// A social call: one listening call in one room, for an arrival or the heartbeat.
// An arrival is admitted like a chunk call, the heartbeat only at the full tier.
// `beforeCall` runs once the money is reserved and may still stop the call. The
// frame shows the room's context only: items still buffered keep to their own
// chunk, and if the agent sends, the §3.6 recheck shows it those items first.
// Whatever the outcome, the caller has already given this up: nothing is retried.
export async function runSocialCycle(h: CycleHost, roomId: string, due: SocialDue, beforeCall: () => boolean = () => true): Promise<CycleOutcome> {
  if (!h.postingAllowed() || !h.presentIn(roomId)) return 'empty'; // nothing the call could say
  if (!admitted(h, due.kind === 'heartbeat' ? 'heartbeat' : 'room_content')) return 'no_budget';
  const instr = h.beginAction();
  await h.registry.ensure(h.listener.pendingAuthors(roomId));
  const view = h.listener.plan(roomId, h.now(), 'recheck');
  if (!view) return 'empty';
  const plan: ChunkPlan = { ...view, deliver: [], collapsed: [], backlog: 0, dirty: false };
  const prompt = h.frame('social', instr, { roomId, plan, social: due, maxBytes: chunkMaxBytes(h) });
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), h.maxOut.listen) + recheckCost(h), 0);
  if (!res) return 'no_budget';
  try {
    if (!beforeCall()) return 'no_budget';
    const out = await callModel(h, res, prompt, 'listen', h.maxOut.listen, false);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'social', h.postingAllowed());
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'social');
      return 'rejected';
    }
    const send = sendIn(parsed.actions);
    if (send && send.room_id !== roomId) {
      h.rejected('send must target the room of this call', 'social');
      return 'rejected';
    }
    await h.execute(sideActions(parsed.actions), roomId);
    if (send) await recheckAndSend(h, res, roomId, send, instr);
    return 'done';
  } finally {
    h.governor.release(res);
  }
}

export interface MemoryReview {
  view: MemoryReviewView;
  frameChars: number;
  started(): void; // the money is reserved and the call is about to go: this review counts
  declined(): void; // the agent chose not to compact
  compact(text: string): string | null; // what went wrong, if anything; on null it is done
}

// What a compacted memory needs, and why it was refused if not. The harness's own
// check: the limit depends on the operator's numbers, and the agent gets told.
export function compactProblem(text: string, frameChars: number): string | null {
  if (text.trim().length === 0) return 'the compacted memory is empty';
  if (text.length > frameChars) return `the compacted memory is ${text.length} characters, over the limit of ${frameChars}`;
  return null;
}

// A compacted memory comes back as output, so a review may need more room than a
// listening reply, and reserves it: the limit is in characters of any size.
export function memoryReviewMaxOut(h: CycleHost, frameChars: number): number {
  return Math.max(h.maxOut.listen, Math.ceil(frameChars / 3) + 256);
}

// A compaction review: one listening call, at the full tier only. The review counts
// from the moment the call is about to start, so a failed or rejected one cannot be
// retried before its cooldown. Nothing the agent asks for happens until the whole
// reply has passed validation.
export async function runMemoryCycle(h: CycleHost, m: MemoryReview): Promise<CycleOutcome> {
  if (!admitted(h, 'memory_review')) return 'no_budget';
  const instr = h.beginAction();
  const prompt = h.frame('memory', instr, { memoryReview: m.view, maxBytes: chunkMaxBytes(h) });
  const maxOut = memoryReviewMaxOut(h, m.frameChars);
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), maxOut), 0);
  if (!res) return 'no_budget';
  const refuse = (reason: string): CycleOutcome => {
    h.rejected(reason, 'memory');
    h.feedback?.(`Your memory review was rejected and nothing changed: ${reason}.`);
    return 'rejected';
  };
  try {
    m.started();
    const out = await callModel(h, res, prompt, 'listen', maxOut, false);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'memory');
    if (!parsed.ok) return refuse(parsed.reason);
    const compact = parsed.actions.find((a) => a.type === 'memory_compact');
    if (compact && compact.type === 'memory_compact') {
      const problem = compactProblem(compact.text, m.frameChars);
      if (problem) return refuse(problem);
    }
    await h.execute(parsed.actions.filter((a) => a.type === 'archive_note'), null);
    if (!compact || compact.type !== 'memory_compact') {
      m.declined();
      return 'done';
    }
    const problem = m.compact(compact.text);
    return problem ? refuse(problem) : 'done';
  } finally {
    h.governor.release(res);
  }
}

// The results of an archive search, in their own call, as an expand's items are. It
// is admitted as a chunk call is, and shows the room the search was made from, with
// its context only: items still buffered keep to their own chunk.
export async function runArchiveCycle(h: CycleHost, found: ArchiveFound, fromRoom: string | null): Promise<CycleOutcome> {
  if (!admitted(h, 'archive')) return 'no_budget';
  const instr = h.beginAction();
  const roomId = fromRoom !== null && h.presentIn(fromRoom) ? fromRoom : null;
  let plan: ChunkPlan | undefined;
  if (roomId !== null) {
    await h.registry.ensure(h.listener.pendingAuthors(roomId));
    const view = h.listener.plan(roomId, h.now(), 'recheck');
    if (view) plan = { ...view, deliver: [], collapsed: [], backlog: 0, dirty: false };
  }
  const prompt = h.frame('archive', instr, { roomId: roomId ?? undefined, plan, archive: found, maxBytes: chunkMaxBytes(h) });
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), h.maxOut.listen) + recheckCost(h), 0);
  if (!res) return 'no_budget';
  try {
    const out = await callModel(h, res, prompt, 'listen', h.maxOut.listen, false);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'archive', h.postingAllowed());
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'archive');
      return 'rejected';
    }
    const send = sendIn(parsed.actions);
    if (send && (roomId !== null ? send.room_id !== roomId : !h.presentIn(send.room_id))) {
      h.rejected('send must target the room of this search, or a room you are present in', 'archive');
      return 'rejected';
    }
    await h.execute(sideActions(parsed.actions), roomId);
    if (send) await recheckAndSend(h, res, send.room_id, send, instr);
    return 'done';
  } finally {
    h.governor.release(res);
  }
}

// What a room search or message lookup found (or why not), in its own call, as
// an archive search's notes are: admitted like a chunk call, with the room it
// was asked from shown as context only, and no further search from it.
export async function runTranscriptCycle(h: CycleHost, found: TranscriptFound, fromRoom: string | null): Promise<CycleOutcome> {
  if (!admitted(h, 'transcript')) return 'no_budget';
  const instr = h.beginAction();
  const roomId = fromRoom !== null && h.presentIn(fromRoom) ? fromRoom : null;
  let plan: ChunkPlan | undefined;
  if (roomId !== null) {
    await h.registry.ensure(h.listener.pendingAuthors(roomId));
    const view = h.listener.plan(roomId, h.now(), 'recheck');
    if (view) plan = { ...view, deliver: [], collapsed: [], backlog: 0, dirty: false };
  }
  const prompt = h.frame('transcript', instr, { roomId: roomId ?? undefined, plan, transcript: found, maxBytes: chunkMaxBytes(h) });
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), h.maxOut.listen) + recheckCost(h), 0);
  if (!res) return 'no_budget';
  try {
    const out = await callModel(h, res, prompt, 'listen', h.maxOut.listen, false);
    if (!out) return 'failed';
    const parsed = parse(h, out.text, 'transcript', h.postingAllowed());
    if (!parsed.ok) {
      h.rejected(parsed.reason, 'transcript');
      return 'rejected';
    }
    const send = sendIn(parsed.actions);
    if (send && (roomId !== null ? send.room_id !== roomId : !h.presentIn(send.room_id))) {
      h.rejected('send must target the room of this search, or a room you are present in', 'transcript');
      return 'rejected';
    }
    await h.execute(sideActions(parsed.actions), roomId);
    if (send) await recheckAndSend(h, res, send.room_id, send, instr);
    return 'done';
  } finally {
    h.governor.release(res);
  }
}

// A backend that failed is probed with one small reserved call; success
// lifts the step-down.
export async function probeBackend(h: CycleHost): Promise<boolean> {
  if (!admitted(h, 'health_probe')) return false;
  const prompt ='{"task":"health_check","reply_format":"{\\"actions\\":[{\\"type\\":\\"silence\\"}]}"}';
  const res = h.governor.reserve(costOf(h, 'listen', callBytes(prompt), 64), 0, true);
  if (!res) return false;
  try {
    return (await callModel(h, res, prompt, 'listen', 64, false)) !== null;
  } finally {
    h.governor.release(res);
  }
}
