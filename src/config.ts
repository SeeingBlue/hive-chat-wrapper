// Wrapper configuration: loading, defaults, validation. Founding values from
// the design are defaults here and remain operator-configurable. Config holds
// paths only, never secrets.
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './util.ts';
import { DEFAULT_WIRE_URL } from './wire.ts';
import { DEFAULT_CEILING_MULTIPLIER, DEFAULT_HOURLY_CAP_FRACTION } from './governor.ts';
import { memoryOf } from './memory.ts';
import type { MemoryConfig } from './memory.ts';

export type Currency = 'tokens' | 'usd';

export interface BudgetConfig {
  currency: Currency;
  periodAllowance: number; // tokens or USD, set by the agent operator
  periodDays: number; // period length in days, set by the agent operator
  periodStart?: string; // YYYY-MM-DD (UTC) anchor; default: first run
  escalationShare: number; // fraction of the period allowance usable by escalated calls
  maxEscalationsPerHour: number; // wrapper default "escalation taste"
  ceilingMultiplier: number; // a day's ceiling is at most this × the daily base; 1 makes the base the line
  hourlyCapFraction: number; // rolling 60-minute spend cap, as a fraction of today's ceiling; 0 turns it off
}

export interface ListeningConfig {
  conversationIntervalMs: number; // §3.3: ~20 s
  conversationMaxMessages: number; // §3.3: or 30 messages
  presentIntervalMs: number; // §3.3: every 5 minutes
  triggerCapPerHour: number; // §3.3: ~4 per room per hour
  authorCharsPerHour: number; // §3.3: 30,000 characters per author per room per hour
  awayTailThresholdMs: number; // away longer than this → recency-first tail
  tailSize: number; // §3.3: last 200 messages
  digestMaxAgeMs: number; // §3.3: or 24 hours
  recentContext: number; // already-seen items shown for continuity
  maxChunkItems: number; // items per model call (rest stays buffered)
}

export interface CooldownConfig {
  quietThresholdMs: number; // wire quiet shorter than this leaves the intervals at base
  multiplierCurve: number[]; // one step per further threshold of quiet, at most 4x
}

export interface HeartbeatConfig {
  maxPerDay: number; // heartbeat calls per agent per rolling 24 hours
  roomQuietMs: number; // how long a room must have had no messages
}

export interface SocialConfig {
  arrivals: boolean; // a newcomer in a room gets one conversation call
  heartbeat: HeartbeatConfig | null; // null: no heartbeat
}

export interface AdapterConfig {
  kind: 'mock' | 'cli' | 'anthropic';
  [k: string]: unknown;
}

export interface WrapperConfig {
  baseUrl?: string;
  socketPath?: string;
  host?: string;
  stateDir: string;
  agentDir: string;
  modelKeyFile?: string;
  adapter: AdapterConfig;
  budget: BudgetConfig;
  listening: ListeningConfig;
  maxRooms: number;
  tickMs: number;
  directoryReviewMs: number;
  maxOutputTokens: { listen: number; mid: number; frontier: number; recheck: number };
  stepDownNotices: { budget: string; backend: string };
  quiet: boolean;
  // 'enforce': register/run refuse to proceed unless the backend passes the
  // tool-free startup probe. 'skip': no probe gate — an agent's tooling is
  // its operator's responsibility (platform decision, 2026-10-30). The probe
  // remains available as a manual diagnostic via the probe command.
  startupProbe: 'enforce' | 'skip';
  // Where to read the AI-news wire; null turns it off. Ignored over a Unix
  // socket, where the wire comes from the same platform.
  wireUrl: string | null;
  // Resident installs only: a new story on the wire gets one conversation call
  // (Joshua's decision, 2026-10-31), and the wire is read every 10 minutes.
  newsSpark: boolean;
  // Under newsSpark only: while the wire is quiet, the directory review and wire
  // poll intervals stretch. Conversation is never stretched.
  cooldown: CooldownConfig;
  // Social initiative (Joshua's decision, 2026-10-31): arrival greetings and a
  // capped heartbeat. Both off unless this key turns them on.
  social: SocialConfig;
  // Room names (Joshua's decision, 2026-11-01). Set and non-empty: joining any other
  // room as attentive or present becomes a watch, see focus.ts. Empty: no policy.
  focusRooms: string[];
  // Active memory and the archive, see memory.ts. An operator's applied settings
  // override these while the wrapper runs.
  memory: MemoryConfig;
}

export const DEFAULT_HEARTBEAT: HeartbeatConfig = {
  maxPerDay: 2,
  roomQuietMs: 10_800_000,
};

export const MAX_COOLDOWN_MULTIPLIER = 4;

export const DEFAULT_COOLDOWN: CooldownConfig = {
  quietThresholdMs: 3_600_000,
  multiplierCurve: [2, 3, MAX_COOLDOWN_MULTIPLIER],
};

export const DEFAULT_LISTENING: ListeningConfig = {
  conversationIntervalMs: 20_000,
  conversationMaxMessages: 30,
  presentIntervalMs: 300_000,
  triggerCapPerHour: 4,
  authorCharsPerHour: 30_000,
  awayTailThresholdMs: 600_000,
  tailSize: 200,
  digestMaxAgeMs: 86_400_000,
  recentContext: 12,
  maxChunkItems: 60,
};

export const DEFAULT_NOTICES = {
  budget: 'Stepping back for now — my budget for today is used up. Back later.',
  backend: 'Stepping back for now — my model backend is not responding. Back later.',
};

function num(v: unknown, def: number, name: string, min = 0): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new Error(`config: ${name} must be a number >= ${min}`);
  return v;
}

function cooldownOf(raw: any): CooldownConfig {
  const curve = raw?.multiplierCurve ?? DEFAULT_COOLDOWN.multiplierCurve;
  if (!Array.isArray(curve) || curve.length === 0 || curve.some((m, i) => typeof m !== 'number' || !Number.isFinite(m) || m < 1 || (i > 0 && m < curve[i - 1]))) {
    throw new Error('config: cooldown.multiplierCurve must be a non-empty list of rising numbers >= 1');
  }
  return {
    quietThresholdMs: num(raw?.quietThresholdMs, DEFAULT_COOLDOWN.quietThresholdMs, 'cooldown.quietThresholdMs', 1),
    multiplierCurve: curve.map((m: number) => Math.min(MAX_COOLDOWN_MULTIPLIER, m)),
  };
}

function isPlainObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fractionOf(v: unknown, def: number, name: string): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`config: ${name} must be a number from 0 to 1`);
  return v;
}

function focusRoomsOf(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((n) => typeof n !== 'string' || n.trim().length === 0)) throw new Error('config: focusRooms must be a list of room names');
  return raw;
}

function socialOf(raw: any): SocialConfig {
  if (raw === undefined || raw === null) return { arrivals: false, heartbeat: null };
  if (!isPlainObject(raw)) throw new Error('config: social must be an object');
  if (raw.arrivals !== undefined && raw.arrivals !== null && typeof raw.arrivals !== 'boolean') throw new Error('config: social.arrivals must be true or false');
  const hb = raw.heartbeat;
  if (hb !== undefined && hb !== null && !isPlainObject(hb)) throw new Error('config: social.heartbeat must be an object');
  return {
    arrivals: raw.arrivals === true,
    heartbeat: hb === undefined || hb === null ? null : {
      maxPerDay: Math.floor(num(hb.maxPerDay, DEFAULT_HEARTBEAT.maxPerDay, 'social.heartbeat.maxPerDay')),
      roomQuietMs: num(hb.roomQuietMs, DEFAULT_HEARTBEAT.roomQuietMs, 'social.heartbeat.roomQuietMs'),
    },
  };
}

export function normalizeConfig(raw: any, baseDir: string): WrapperConfig {
  if (!raw || typeof raw !== 'object') throw new Error('config: expected an object');
  const abs = (p: unknown, name: string): string => {
    if (typeof p !== 'string' || p.length === 0) throw new Error(`config: ${name} is required`);
    return path.resolve(baseDir, p);
  };
  if (!raw.baseUrl && !raw.socketPath) throw new Error('config: set baseUrl or socketPath');
  // Over a Unix socket the platform routes by Host; without one every call
  // would be refused as misdirected (421).
  if (raw.socketPath && !raw.baseUrl && (typeof raw.host !== 'string' || raw.host.length === 0)) {
    throw new Error('config: host is required with socketPath (the platform public hostname, e.g. hive-chat.com)');
  }
  const stateDir = abs(raw.stateDir, 'stateDir');
  const agentDir = abs(raw.agentDir, 'agentDir');
  if (isInside(agentDir, stateDir) || isInside(stateDir, agentDir)) {
    throw new Error('config: stateDir (keys) and agentDir (model-readable files) must be separate, non-nested directories');
  }
  const modelKeyFile = raw.modelKeyFile ? abs(raw.modelKeyFile, 'modelKeyFile') : undefined;
  if (modelKeyFile && isInside(modelKeyFile, agentDir)) throw new Error('config: modelKeyFile must not be inside agentDir');

  const adapter = raw.adapter as AdapterConfig;
  if (!adapter || !['mock', 'cli', 'anthropic'].includes(adapter.kind)) throw new Error('config: adapter.kind must be mock, cli or anthropic');

  const b = raw.budget ?? {};
  const currency: Currency = b.currency === 'tokens' ? 'tokens' : b.currency === 'usd' || b.currency === undefined ? 'usd' : (() => {
    throw new Error('config: budget.currency must be tokens or usd');
  })();
  if (currency === 'tokens' && (typeof b.periodAllowance !== 'number' || typeof b.periodDays !== 'number')) {
    // Subscription vendors publish no token pool: the operator must set both.
    throw new Error('config: token budgets need an explicit budget.periodAllowance and budget.periodDays');
  }
  const budget: BudgetConfig = {
    currency,
    periodAllowance: num(b.periodAllowance, 100, 'budget.periodAllowance'), // $100/month default (§3.8)
    periodDays: Math.floor(num(b.periodDays, 30, 'budget.periodDays', 1)),
    periodStart: typeof b.periodStart === 'string' ? b.periodStart : undefined,
    escalationShare: Math.min(1, num(b.escalationShare, 0.5, 'budget.escalationShare')),
    maxEscalationsPerHour: num(b.maxEscalationsPerHour, 6, 'budget.maxEscalationsPerHour'),
    ceilingMultiplier: num(b.ceilingMultiplier, DEFAULT_CEILING_MULTIPLIER, 'budget.ceilingMultiplier', 1),
    hourlyCapFraction: fractionOf(b.hourlyCapFraction, DEFAULT_HOURLY_CAP_FRACTION, 'budget.hourlyCapFraction'),
  };
  if (budget.periodStart && !/^\d{4}-\d{2}-\d{2}$/.test(budget.periodStart)) throw new Error('config: budget.periodStart must be YYYY-MM-DD');

  const l = raw.listening ?? {};
  const listening: ListeningConfig = { ...DEFAULT_LISTENING };
  for (const k of Object.keys(DEFAULT_LISTENING) as Array<keyof ListeningConfig>) {
    listening[k] = num(l[k], DEFAULT_LISTENING[k], `listening.${k}`, 1);
  }
  listening.tailSize = Math.min(200, listening.tailSize);

  const mo = raw.maxOutputTokens ?? {};
  const notices = raw.stepDownNotices ?? {};
  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
    socketPath: raw.socketPath ? abs(raw.socketPath, 'socketPath') : undefined,
    host: typeof raw.host === 'string' ? raw.host : undefined,
    stateDir,
    agentDir,
    modelKeyFile,
    adapter,
    budget,
    listening,
    maxRooms: Math.min(5, Math.floor(num(raw.maxRooms, 5, 'maxRooms', 1))), // §5.4 cap is 5
    tickMs: num(raw.tickMs, 1000, 'tickMs', 10),
    directoryReviewMs: num(raw.directoryReviewMs, 1_800_000, 'directoryReviewMs', 1000),
    maxOutputTokens: {
      listen: num(mo.listen, 1024, 'maxOutputTokens.listen', 16),
      mid: num(mo.mid, 2048, 'maxOutputTokens.mid', 16),
      frontier: num(mo.frontier, 4096, 'maxOutputTokens.frontier', 16),
      recheck: num(mo.recheck, 1024, 'maxOutputTokens.recheck', 16),
    },
    stepDownNotices: {
      budget: typeof notices.budget === 'string' ? notices.budget : DEFAULT_NOTICES.budget,
      backend: typeof notices.backend === 'string' ? notices.backend : DEFAULT_NOTICES.backend,
    },
    quiet: raw.quiet === true,
    startupProbe: raw.startupProbe === 'skip' ? 'skip' : 'enforce',
    wireUrl: raw.wireUrl === null ? null : typeof raw.wireUrl === 'string' ? raw.wireUrl : DEFAULT_WIRE_URL,
    newsSpark: raw.newsSpark === true,
    cooldown: cooldownOf(raw.cooldown),
    social: socialOf(raw.social),
    focusRooms: focusRoomsOf(raw.focusRooms),
    memory: memoryOf(raw.memory),
  };
}

export function loadConfig(file: string): WrapperConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeConfig(raw, path.dirname(path.resolve(file)));
}
