// Budget governor (Design §3.8). Per-agent, in the currency that is scarce for
// this backend (tokens or USD), persisted to <stateDir>/governor.json (0600).
//
// Pacing: base = allowance / periodDays. Today's ceiling =
//   min(ceilingMultiplier × base, saved + base, allowance − spentBeforeToday)
// with saved = max(0, base × fullDaysElapsed − spentBeforeToday). Nothing rolls
// over a period boundary. At a multiplier of 1 saved allowance no longer raises
// the ceiling: the base is the day's line until the allowance runs short.
//
// Hard-cap mode (adapter declares bounded calls with an enforceable maximum):
// every call reserves its maximum cost first; a call that cannot fit does not
// start; actual usage is settled against the reservation and the remainder is
// released. Escalated cost is also reserved against the escalation sub-budget
// (a slice of the period allowance, not an addition to it).
//
// Best-effort mode (backend runs its own loop): a reservation holds an estimate,
// not a maximum. A call whose estimate cannot fit does not start, but the backend
// can still spend more than estimated. Pacing and step-down come from reported
// usage and vendor-limit errors.
//
// Either way, an actual above its reservation is recorded as overage in the
// ledger, with the tier recomputed at that moment. admits() is the hard gate on
// which calls may start at each tier.
//
// Hourly pacing: the daily ceiling alone lets a whole day burn in minutes, so a
// call also has to fit a rolling 60-minute cap, a fraction of today's ceiling. It
// refuses calls and changes no tier. The health probe and a hard-cap recheck that
// already holds its money are exempt, as they are from the hard gates.
//
// Chat text can never reach this module: only operator config sets budgets.
import { readJson, writePrivate, DAY_MS } from './util.ts';
import type { Usage } from './adapters/types.ts';

export type Currency = 'tokens' | 'usd';
export type GovTier = 'full' | 'present' | 'exhausted';

export const DEFAULT_CEILING_MULTIPLIER = 3;
export const DEFAULT_HOURLY_CAP_FRACTION = 0.25;
export const SPEND_WINDOW_MS = 3_600_000;
// Spend is logged in one-minute buckets, stamped with the end of the minute. The
// log therefore needs no count limit, and spend leaves the window at most a minute
// late, never early.
export const SPEND_BUCKET_MS = 60_000;

// Every kind of call that can start outside a running cycle. A recheck is part of
// its cycle and asks mayContinue() instead. `news` is a spark carrying article text,
// `news_headline` one carrying headlines and sources only.
// `transcript` carries what a room search or message lookup found, admitted
// exactly as `archive` is.
export type CallKind = 'room_content' | 'expand' | 'escalation' | 'directory' | 'news' | 'news_headline' | 'heartbeat' | 'memory_review' | 'archive' | 'transcript' | 'registration' | 'startup_probe' | 'health_probe';

export interface OverageEvent {
  at: number;
  reserved: number; // what the reservation still covered when this call settled
  actual: number;
  excess: number; // actual beyond the reservation
  pastCeiling: number; // the part of this spend that landed above the day's ceiling
  tier: GovTier; // recomputed as this spend landed
}

export interface HourlyCapEvent {
  kind: string; // the call refused
  spent: number; // in the trailing 60 minutes, open reservations included
  estimate: number;
  cap: number;
}

interface Overage {
  total: number;
  pastCeiling: number;
  events: OverageEvent[]; // the most recent ones
}

export interface GovernorOptions {
  currency: Currency;
  periodAllowance: number;
  periodDays: number;
  periodStartMs?: number; // anchor; default: UTC midnight of first run
  escalationShare: number;
  ceilingMultiplier?: number; // default DEFAULT_CEILING_MULTIPLIER
  hourlyCapFraction?: number; // of today's ceiling; absent or 0: no hourly cap (config.ts sets the default)
  hardCap: boolean;
  file: string | null;
  now?: () => number;
}

export interface Reservation {
  id: number;
  amount: number; // total reserved (the maximum in hard-cap, an estimate in best-effort)
  escAmount: number; // portion reserved against the escalation sub-budget
  used: number;
  escUsed: number;
  open: boolean;
}

export interface BudgetSnapshot {
  base: number;
  dayIndex: number;
  ceiling: number;
  spentToday: number;
  spentBeforeToday: number;
  periodSpent: number;
  reserved: number;
  todayRemaining: number;
  periodRemaining: number;
  escalationSlice: number;
  escalationSpent: number;
  escalationRemaining: number;
  fraction: number; // share of the constraining allowance already spent
  overage: number; // this period: actual spend beyond reservations
  pastCeiling: number; // this period: spend that landed above a day's ceiling
  pastAllowance: number; // spend above the period allowance
  msUntilDayRolls: number; // when the governor day ends, from the period anchor
  spentLastHour: number; // settled spend in the trailing 60 minutes
  hourlyCap: number; // 0 when there is no hourly cap
}

interface Ledger {
  version: 1;
  periodStartMs: number;
  periodIndex: number;
  spentByDay: number[];
  escalationSpent: number;
  outstanding: number; // open reservations at last save (charged on restart)
  escOutstanding?: number; // escalated part of `outstanding` (absent in older ledgers)
  overage?: Overage; // this period's (absent in older ledgers)
  spendLog?: Array<[number, number]>; // [bucket end, amount] for the trailing 60 minutes (absent in older ledgers)
}

const EPS = 1e-9;
const OVERAGE_EVENTS_KEPT = 20;

export class Governor {
  readonly opts: GovernorOptions;
  private readonly now: () => number;
  private ledger: Ledger;
  private readonly reservations = new Map<number, Reservation>();
  private nextId = 1;
  private minListen = 0; // the last minimum listening cost asked about
  failing = false; // a backend whose calls fail steps down as at exhaustion
  vendorLimitedUntil = 0; // vendor's own limit reached
  onOverage: ((e: OverageEvent) => void) | null = null;
  onHourlyCap: ((e: HourlyCapEvent) => void) | null = null;

  constructor(opts: GovernorOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    const loaded = opts.file ? readJson<Ledger | null>(opts.file, null) : null;
    if (loaded && loaded.version === 1 && Array.isArray(loaded.spentByDay)) {
      this.ledger = loaded;
      this.ledger.spendLog = Array.isArray(loaded.spendLog) ? loaded.spendLog.filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1])) : [];
      // Calls that were in flight when the wrapper stopped: we cannot know
      // whether they ran, so the conservative reading is that they did. Read
      // the amounts before zeroing them: `loaded` is the same object.
      const carried = Math.max(0, loaded.outstanding ?? 0);
      const escCarried = Math.max(0, loaded.escOutstanding ?? 0);
      if (carried > 0 || escCarried > 0) {
        this.ledger.outstanding = 0;
        this.ledger.escOutstanding = 0;
        this.roll();
        this.addSpend(carried, escCarried);
      }
    } else {
      const t = this.now();
      this.ledger = {
        version: 1,
        periodStartMs: opts.periodStartMs ?? t - (t % DAY_MS),
        periodIndex: -1,
        spentByDay: [],
        escalationSpent: 0,
        outstanding: 0,
        escOutstanding: 0,
      };
    }
    this.roll();
    this.save();
  }

  get hardCap(): boolean {
    return this.opts.hardCap;
  }

  // Converts reported or maximum usage into this governor's currency.
  amountOf(u: Usage): number {
    if (this.opts.currency === 'usd') return u.costUsd ?? 0;
    return u.inputTokens + u.outputTokens;
  }

  private dayPosition(): { periodIndex: number; dayIndex: number; dayRollsAtMs: number } {
    const len = this.opts.periodDays * DAY_MS;
    const since = Math.max(0, this.now() - this.ledger.periodStartMs);
    const periodIndex = Math.floor(since / len);
    const dayIndex = Math.floor((since - periodIndex * len) / DAY_MS);
    return { periodIndex, dayIndex, dayRollsAtMs: this.ledger.periodStartMs + periodIndex * len + (dayIndex + 1) * DAY_MS };
  }

  private roll(): number {
    const { periodIndex, dayIndex } = this.dayPosition();
    if (periodIndex !== this.ledger.periodIndex) {
      this.ledger.periodIndex = periodIndex;
      this.ledger.spentByDay = [];
      this.ledger.escalationSpent = 0;
      delete this.ledger.overage;
    }
    return dayIndex;
  }

  snapshot(): BudgetSnapshot {
    const day = this.roll();
    const A = this.opts.periodAllowance;
    const base = A / this.opts.periodDays;
    let before = 0;
    for (let i = 0; i < day; i++) before += this.ledger.spentByDay[i] ?? 0;
    const today = this.ledger.spentByDay[day] ?? 0;
    const saved = Math.max(0, base * day - before);
    const multiplier = this.opts.ceilingMultiplier ?? DEFAULT_CEILING_MULTIPLIER;
    const ceiling = Math.max(0, Math.min(multiplier * base, saved + base, A - before));
    let reserved = 0;
    let escReserved = 0;
    for (const r of this.reservations.values()) {
      reserved += Math.max(0, r.amount - r.used);
      escReserved += Math.max(0, r.escAmount - r.escUsed);
    }
    const periodSpent = before + today;
    const slice = A * this.opts.escalationShare;
    const dayFraction = ceiling > EPS ? today / ceiling : 1;
    const periodFraction = A > EPS ? periodSpent / A : 1;
    return {
      base,
      dayIndex: day,
      ceiling,
      spentToday: today,
      spentBeforeToday: before,
      periodSpent,
      reserved,
      todayRemaining: ceiling - today - reserved,
      periodRemaining: A - periodSpent - reserved,
      escalationSlice: slice,
      escalationSpent: this.ledger.escalationSpent,
      escalationRemaining: slice - this.ledger.escalationSpent - escReserved,
      fraction: Math.max(dayFraction, periodFraction),
      overage: this.ledger.overage?.total ?? 0,
      pastCeiling: this.ledger.overage?.pastCeiling ?? 0,
      pastAllowance: Math.max(0, periodSpent - A),
      msUntilDayRolls: this.dayPosition().dayRollsAtMs - this.now(),
      spentLastHour: this.spentInWindow(),
      hourlyCap: (this.opts.hourlyCapFraction ?? 0) * ceiling,
    };
  }

  // The window does not reset at a day or period boundary: an hour of spend is an
  // hour of spend whichever day it landed in.
  private spentInWindow(): number {
    const now = this.now();
    let spent = 0;
    for (const [at, amount] of this.ledger.spendLog ?? []) if (now - at < SPEND_WINDOW_MS) spent += amount; // a future time stays counted
    return spent;
  }

  private logSpend(amount: number): void {
    if (amount <= 0) return;
    const now = this.now();
    const log = (this.ledger.spendLog ?? []).filter(([at]) => now - at < SPEND_WINDOW_MS);
    const at = Math.ceil(now / SPEND_BUCKET_MS) * SPEND_BUCKET_MS;
    const last = log[log.length - 1];
    if (last && last[0] === at) last[1] += amount;
    else log.push([at, amount]);
    this.ledger.spendLog = log;
  }

  // `held` is what the asking call already has reserved. The money was checked
  // when the reservation was made, so it is not counted twice.
  private overHourlyCap(amount: number, held = 0): boolean {
    if ((this.opts.hourlyCapFraction ?? 0) <= 0) return false;
    const s = this.snapshot();
    return s.spentLastHour + s.reserved - held + amount > s.hourlyCap + EPS;
  }

  // Whether no call of this size may start for now, and tells the wrapper's log so.
  private refusedByHourlyCap(kind: string, amount: number, held = 0): boolean {
    if (!this.overHourlyCap(amount, held)) return false;
    const s = this.snapshot();
    this.onHourlyCap?.({ kind, spent: s.spentLastHour + s.reserved - held, estimate: amount, cap: s.hourlyCap });
    return true;
  }

  canFit(amount: number, escAmount: number, s: BudgetSnapshot = this.snapshot()): boolean {
    // Best-effort: nothing starts once visible spend reaches today's ceiling.
    if (!this.opts.hardCap && (s.spentToday >= s.ceiling - EPS || s.periodSpent >= this.opts.periodAllowance - EPS)) return false;
    if (amount > s.todayRemaining + EPS || amount > s.periodRemaining + EPS) return false;
    if (escAmount > 0 && escAmount > s.escalationRemaining + EPS) return false;
    return true;
  }

  // Reserve `amount` (of which `escAmount` is escalated). Returns null when the
  // call cannot fit: it must then not start. This is where the hourly cap sees the
  // call's real estimate, which admits() can only guess before the frame is built.
  reserve(amount: number, escAmount = 0, hourlyCapExempt = false): Reservation | null {
    if (!this.canFit(amount, escAmount)) return null;
    if (!hourlyCapExempt && this.refusedByHourlyCap('call', amount)) return null;
    const r: Reservation = {
      id: this.nextId++,
      amount,
      escAmount,
      used: 0,
      escUsed: 0,
      open: true,
    };
    this.reservations.set(r.id, r);
    this.save();
    return r;
  }

  // Record actual spend for one call drawn against a reservation. A compose
  // cycle settles several calls against one reservation before release().
  settle(r: Reservation, actual: number, escalated: boolean): void {
    const amt = Math.max(0, actual);
    const covered = r.open ? Math.max(0, r.amount - r.used) : 0;
    if (r.open) {
      r.used += amt;
      if (escalated) r.escUsed += amt;
    }
    this.addSpend(amt, escalated ? amt : 0, covered);
  }

  // Release the unused remainder of a reservation.
  release(r: Reservation): void {
    if (!r.open) return;
    r.open = false;
    this.reservations.delete(r.id);
    this.save();
  }

  // Spend observed outside a reservation (e.g. best-effort probe calls).
  record(actual: number, escalated: boolean): void {
    const amt = Math.max(0, actual);
    this.addSpend(amt, escalated ? amt : 0);
  }

  // `covered` is how much of this spend a reservation allowed for. Spend with no
  // reservation at all (a probe, a call charged after a crash) has no excess, but
  // can still land past the ceiling.
  private addSpend(amount: number, escAmount: number, covered = amount): void {
    const before = this.snapshot();
    const day = before.dayIndex;
    this.ledger.spentByDay[day] = before.spentToday + amount;
    this.logSpend(amount);
    this.ledger.escalationSpent += escAmount;
    const excess = Math.max(0, amount - covered);
    const pastCeiling = Math.max(0, before.spentToday + amount - Math.max(before.spentToday, before.ceiling));
    if (excess > EPS || pastCeiling > EPS) this.noteOverage(amount, covered, excess, pastCeiling);
    this.save();
  }

  private noteOverage(actual: number, reserved: number, excess: number, pastCeiling: number): void {
    const o = (this.ledger.overage ??= { total: 0, pastCeiling: 0, events: [] });
    o.total += excess;
    o.pastCeiling += pastCeiling;
    const event: OverageEvent = { at: this.now(), reserved, actual, excess, pastCeiling, tier: this.tier(this.minListen) };
    o.events.push(event);
    if (o.events.length > OVERAGE_EVENTS_KEPT) o.events.splice(0, o.events.length - OVERAGE_EVENTS_KEPT);
    this.onOverage?.(event);
  }

  noteSuccess(): void {
    this.failing = false;
    this.vendorLimitedUntil = 0;
  }

  noteFailure(): void {
    this.failing = true;
  }

  noteVendorLimit(retryAfterMs: number | null): void {
    this.vendorLimitedUntil = this.now() + (retryAfterMs ?? 3_600_000);
  }

  // Presence tier: attentive → present at 75 % spent, → watch/away at 100 %.
  // Inability to reserve the minimum listening call counts as exhaustion
  // (hard-cap only), as do failing calls and the vendor's own limit.
  tier(minListenAmount: number): GovTier {
    this.minListen = minListenAmount;
    if (this.failing || this.now() < this.vendorLimitedUntil) return 'exhausted';
    return this.budgetTier(minListenAmount);
  }

  // The tier the money alone allows, whatever the backend's health.
  private budgetTier(minListenAmount: number): GovTier {
    const s = this.snapshot();
    if (s.fraction >= 1 - EPS) return 'exhausted';
    if (this.opts.hardCap && !this.canFit(minListenAmount, 0, s)) return 'exhausted';
    if (this.opts.hardCap === false && !this.canFit(0, 0, s)) return 'exhausted';
    if (s.fraction >= 0.75 - EPS) return 'present';
    return 'full';
  }

  // The hard gate, asked just before a call would start. At present only
  // listening-tier processing of new room content runs, an archive search's
  // results and a room search's or lookup's, which are admitted the same way,
  // and a news spark in headline form, which carries no article text. At
  // exhausted nothing does,
  // with one exception: when the budget is fine and only the backend is failing,
  // the small health probe is the way back ("until a call succeeds", §3.8). Every
  // other call must also fit the hourly cap. Before its frame exists, a call's
  // estimate is taken to be the smallest listening action.
  admits(kind: CallKind, minListenAmount: number, estimate = minListenAmount): boolean {
    if (kind === 'health_probe') return this.failing && this.now() >= this.vendorLimitedUntil && this.budgetTier(minListenAmount) !== 'exhausted';
    const tier = this.tier(minListenAmount);
    if (tier !== 'full' && !(tier === 'present' && (kind === 'room_content' || kind === 'archive' || kind === 'transcript' || kind === 'news_headline'))) return false;
    return !this.refusedByHourlyCap(kind, estimate);
  }

  // Whether a running cycle's next call (its recheck) may start. A hard-cap cycle
  // already holds that money, so exhaustion alone must not strand it (§3.8) unless
  // an earlier call overran the reservation. A best-effort reservation guarantees
  // nothing, so there the recheck is a new call like any other.
  mayContinue(r: Reservation, amount: number): boolean {
    if (this.failing || this.now() < this.vendorLimitedUntil) return false;
    if (this.opts.hardCap) return r.open && r.amount - r.used >= amount - EPS;
    return this.budgetTier(0) !== 'exhausted' && !this.refusedByHourlyCap('recheck', amount, Math.max(0, r.amount - r.used));
  }

  save(): void {
    if (!this.opts.file) return;
    let outstanding = 0;
    let escOutstanding = 0;
    for (const r of this.reservations.values()) {
      outstanding += Math.max(0, r.amount - r.used);
      escOutstanding += Math.max(0, r.escAmount - r.escUsed);
    }
    this.ledger.outstanding = outstanding;
    this.ledger.escOutstanding = escOutstanding;
    writePrivate(this.opts.file, JSON.stringify(this.ledger));
  }
}
