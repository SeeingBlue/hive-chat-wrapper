// The memory subsystem's numbers and its archive format. Active memory (memory.md)
// is a working set the agent sees in every frame; the archive (archive.md) is where
// everything else goes and is never pruned. An operator can adjust the five numbers
// from the agent-operator page: the platform delivers them with the notices, and they
// are validated again here, because the channel is not trusted.
import { HOUR_MS } from './util.ts';

export interface MemoryConfig {
  frameChars: number; // how much of memory.md each frame shows, newest first
  fileCapChars: number; // memory.md refuses appends past this
  noteMaxChars: number; // one memory_note or archive_note
  reviewThresholdChars: number; // memory.md past this makes a compaction review due
  archiveReturnChars: number; // what one archive search can return in total
}

export type MemoryKey = keyof MemoryConfig;

export const MEMORY_KEYS: MemoryKey[] = ['frameChars', 'fileCapChars', 'noteMaxChars', 'reviewThresholdChars', 'archiveReturnChars'];

export const DEFAULT_MEMORY: MemoryConfig = {
  frameChars: 6_000,
  fileCapChars: 64_000,
  noteMaxChars: 2_000,
  reviewThresholdChars: 12_000,
  archiveReturnChars: 3_000,
};

// reviewThresholdChars is also bound by the other two keys: see relationProblem().
export const MEMORY_BOUNDS: Record<MemoryKey, [number, number]> = {
  frameChars: [2_000, 12_000],
  fileCapChars: [16_000, 256_000],
  noteMaxChars: [200, 4_000],
  reviewThresholdChars: [2_000, 256_000],
  archiveReturnChars: [500, 6_000],
};

export const MEMORY_REVIEW_COOLDOWN_MS = 6 * HOUR_MS;
export const MEMORY_REVIEW_SILENCE_DEFER_MS = HOUR_MS;
export const ARCHIVE_QUERY_MAX_CHARS = 200;
export const ARCHIVE_CALLS_PER_HOUR = 6;
export const OPERATOR_SETTINGS_FILE = 'operator-settings.json';
export const OPERATOR_SETTINGS_POLL_MS = 300_000;

function clamp(v: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, v));
}

function inBounds(key: MemoryKey, v: unknown): v is number {
  const [low, high] = MEMORY_BOUNDS[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= low && v <= high;
}

export function boundsText(key: MemoryKey): string {
  const [low, high] = MEMORY_BOUNDS[key];
  return `a whole number from ${low} to ${high}`;
}

// Local config: anything wrong refuses to start.
export function memoryOf(raw: unknown): MemoryConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_MEMORY };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: memory must be an object');
  const o = raw as Record<string, unknown>;
  const out = { ...DEFAULT_MEMORY };
  for (const key of MEMORY_KEYS) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (!inBounds(key, v)) throw new Error(`config: memory.${key} must be ${boundsText(key)}`);
    out[key] = v;
  }
  if (out.fileCapChars < out.frameChars) throw new Error('config: memory.fileCapChars must be at least memory.frameChars');
  if (out.reviewThresholdChars < out.frameChars || out.reviewThresholdChars > out.fileCapChars) {
    throw new Error('config: memory.reviewThresholdChars must be from memory.frameChars to memory.fileCapChars');
  }
  return out;
}

export interface SanitizedSettings {
  values: Partial<MemoryConfig>;
  dropped: string[]; // what failed validation: the local value stands
  clamped: string[]; // what was a number out of bounds, and is now at its bound
}

// What the platform delivered. A number out of bounds is clamped to them. Anything
// else fails validation, and only that key is dropped.
export function sanitizeSettings(raw: Record<string, unknown>): SanitizedSettings {
  const out: SanitizedSettings = { values: {}, dropped: [], clamped: [] };
  for (const [key, v] of Object.entries(raw)) {
    if (!MEMORY_KEYS.includes(key as MemoryKey)) {
      out.dropped.push(`${key} (not a memory key)`);
      continue;
    }
    const k = key as MemoryKey;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      out.dropped.push(`${k} (not a whole number)`);
      continue;
    }
    const [low, high] = MEMORY_BOUNDS[k];
    const held = clamp(v, low, high);
    if (held !== v) out.clamped.push(`${k} ${v} -> ${held}`);
    out.values[k] = held;
  }
  return out;
}

// Applied operator settings > local agent.json > built-in defaults (`local` already
// holds the defaults). The relations between keys are settled last: each key may
// have come from a different place.
export function resolveMemory(local: MemoryConfig, operator: Partial<MemoryConfig>): MemoryConfig {
  const m = { ...local, ...operator };
  m.fileCapChars = Math.max(m.fileCapChars, m.frameChars);
  m.reviewThresholdChars = clamp(m.reviewThresholdChars, m.frameChars, m.fileCapChars);
  return m;
}

// --------------------------------------------------------------------- the archive

// Each entry is a header line naming the body's length, then the body, so nothing
// the body says can pass for another entry.
export type ArchiveKind = 'note' | 'batch';

const HEADER_RE = /=== (\d{4}-\d{2}-\d{2}T[0-9:.]+Z) (note|batch) (\d+) ===\n/y;
const NOTE_TIME_RE = /^- \[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z\]/;

export function archiveEntry(kind: ArchiveKind, text: string, now: number): string {
  return `=== ${new Date(now).toISOString()} ${kind} ${text.length} ===\n${text}\n`;
}

export interface ArchiveEntry {
  at: number;
  kind: ArchiveKind;
  text: string;
}

function headerAt(text: string, pos: number): RegExpExecArray | null {
  HEADER_RE.lastIndex = pos;
  return HEADER_RE.exec(text);
}

export function parseArchive(text: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  let pos = 0;
  while (pos < text.length) {
    const m = headerAt(text, pos);
    if (!m) {
      // Not an entry (a hand edit): on to the next header, if any.
      const next = text.indexOf('\n=== ', pos);
      if (next < 0) break;
      pos = next + 1;
      continue;
    }
    const start = pos + m[0].length;
    let end = start + Number(m[3]);
    // A torn write (a crash mid-append) breaks the length, so the body then runs to
    // the next header. Nothing that was written is lost to the search.
    if (end > text.length || (end < text.length && text[end] !== '\n') || (end + 1 < text.length && !headerAt(text, end + 1))) {
      const next = text.indexOf('\n=== ', start);
      end = next < 0 ? text.length : next;
    }
    out.push({ at: Date.parse(m[1]), kind: m[2] as ArchiveKind, text: text.slice(start, end) });
    pos = end + 1;
  }
  return out;
}

export interface ArchiveHit {
  at: string; // when the note was written, or archived if that is all that is known
  text: string;
}

// A batch is a whole memory file, far too long to return, so a search looks at it
// line by line. A line written by memory_note keeps its own time.
function searchable(entries: ArchiveEntry[]): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  for (const e of entries) {
    if (e.kind !== 'batch') {
      out.push(e);
      continue;
    }
    for (const line of e.text.split('\n')) {
      if (line.trim().length === 0) continue;
      const own = NOTE_TIME_RE.exec(line);
      const at = own ? Date.parse(`${own[1]}Z`) : NaN;
      out.push({ at: Number.isFinite(at) ? at : e.at, kind: 'batch', text: line });
    }
  }
  return out;
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 0))];
}

// An entry too long for the whole bound still has its best part shown.
function excerpt(text: string, lower: string, terms: string[], max: number): string {
  const hit = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  const from = Math.max(0, hit - Math.floor(max / 4));
  const cut = text.slice(from, from + max - 2);
  return `${from > 0 ? '…' : ''}${cut}${from + max - 2 < text.length ? '…' : ''}`;
}

// A linear scan: most distinct terms matched first, then newest. The same text
// archived again by a later review is one result, the newest. The texts returned
// total at most maxChars.
export function searchArchive(archive: string, query: string, maxChars: number): ArchiveHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored: Array<{ e: ArchiveEntry; lower: string; score: number; index: number }> = [];
  searchable(parseArchive(archive)).forEach((e, index) => {
    const lower = e.text.toLowerCase();
    const score = terms.filter((t) => lower.includes(t)).length;
    if (score > 0) scored.push({ e, lower, score, index });
  });
  scored.sort((a, b) => b.score - a.score || b.e.at - a.e.at || b.index - a.index);
  const hits: ArchiveHit[] = [];
  const seen = new Set<string>();
  let left = maxChars;
  for (const { e, lower } of scored) {
    if (seen.has(e.text)) continue;
    seen.add(e.text);
    if (e.text.length <= left) {
      hits.push({ at: new Date(e.at).toISOString(), text: e.text });
      left -= e.text.length;
    } else if (hits.length === 0) {
      const text = excerpt(e.text, lower, terms, left);
      hits.push({ at: new Date(e.at).toISOString(), text });
      left -= text.length;
    }
  }
  return hits;
}
