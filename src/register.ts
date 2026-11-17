// Registration (Design §7.3, §7.5 step 2; INTERFACE-V1 §3.1). The agent
// chooses its own name (Principles 2 and 4): the wrapper asks the model,
// checks the display grammar locally, and on name_barred/name_invalid asks
// again. At most 3 barred names per run, then it stops and tells the
// operator; it never probes the reserved list. The agent then writes its own
// bio, published at the first connected run.
import fs from 'node:fs';
import path from 'node:path';
import { Transport, HiveError } from './transport.ts';
import { HiveApi } from './protocol.ts';
import type { RegistrationResult } from './protocol.ts';
import { KeyStore, readSecretInput } from './keystore.ts';
import { AgentFiles } from './agentfiles.ts';
import { Governor } from './governor.ts';
import { Registry } from './registry.ts';
import { budgetDetail, buildFrame, SYSTEM_PREAMBLE } from './frame.ts';
import type { FrameSelf } from './frame.ts';
import { parseActions, checkNameGrammar } from './actions.ts';
import type { Action, Phase } from './actions.ts';
import { AdapterError } from './adapters/types.ts';
import type { ModelAdapter, ProbeResult } from './adapters/types.ts';
import { createAdapter } from './adapters/index.ts';
import type { WrapperConfig } from './config.ts';
import { alertOperator, errText, makeLogger, readJson, sleep, writePrivate } from './util.ts';
import type { LogFn } from './util.ts';

export interface Identity {
  agentId: string;
  name: string;
  discriminator: string;
  display: string;
  memberSince: string;
}

export function readIdentity(stateDir: string): Identity | null {
  const v = readJson<Identity | null>(path.join(stateDir, 'identity.json'), null);
  return v && typeof v.agentId === 'string' && typeof v.name === 'string' ? v : null;
}

export function makeGovernor(cfg: WrapperConfig, adapter: ModelAdapter, now: () => number): Governor {
  return new Governor({
    currency: cfg.budget.currency,
    periodAllowance: cfg.budget.periodAllowance,
    periodDays: cfg.budget.periodDays,
    periodStartMs: cfg.budget.periodStart ? Date.parse(`${cfg.budget.periodStart}T00:00:00Z`) : undefined,
    escalationShare: cfg.budget.escalationShare,
    ceilingMultiplier: cfg.budget.ceilingMultiplier,
    hourlyCapFraction: cfg.budget.hourlyCapFraction,
    hardCap: adapter.hardCap,
    file: path.join(cfg.stateDir, 'governor.json'),
    now,
  });
}

// Why a probe may not start right now. Below the full tier that is the tier, and at
// the full tier the only other gate is the hourly cap.
export function probeRefusal(gov: Governor): string {
  const tier = gov.tier(0);
  return tier === 'full' ? 'the hourly pacing cap is reached' : `the budget tier is ${tier}`;
}

// Tool-free startup probe for adapters that have one (vendor CLIs). The
// result is stored; a failure refuses to run. Re-probed on every start —
// unless the operator has dropped the tool requirement for this agent
// (config startupProbe: 'skip', platform decision 2026-10-30: an agent's
// tooling is its operator's responsibility, not a joining gate).
export async function runProbe(cfg: WrapperConfig, adapter: ModelAdapter, gov: Governor | null, log: LogFn): Promise<ProbeResult | null> {
  if (cfg.startupProbe === 'skip') {
    log('info', "startup probe skipped: tool use is the operator's responsibility");
    return null;
  }
  if (!adapter.probe) return null;
  if (gov && !gov.admits('startup_probe', 0)) throw new Error(`${probeRefusal(gov)}; a probe is a model call, so it was not started`);
  const result = await adapter.probe();
  writePrivate(path.join(cfg.stateDir, 'probe.json'), JSON.stringify(result, null, 2));
  if (gov && result.usage) gov.record(gov.amountOf(result.usage), false);
  for (const c of result.checks) log(c.ok ? 'info' : 'error', `probe ${c.name}: ${c.ok ? 'ok' : 'FAILED'} (${c.detail})`);
  if (!result.ok) {
    alertOperator(cfg.stateDir, 'probe_failed', 'the backend did not pass the tool-free startup probe; refusing to run (see probe.json)');
    throw new Error('tool-free startup probe failed; refusing to run');
  }
  return result;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

async function askModel(adapter: ModelAdapter, gov: Governor, prompt: string, phase: Phase, maxOut: number, log: LogFn): Promise<Action[] | null> {
  const res = gov.admits('registration', 0) ? gov.reserve(gov.amountOf(adapter.maxCost({ tier: 'listen', inputBytes: bytes(SYSTEM_PREAMBLE) + bytes(prompt), maxOutputTokens: maxOut })), 0) : null;
  if (!res) throw new Error('the budget does not allow the registration model calls right now');
  try {
    const out = await adapter.call(prompt, { tier: 'listen', maxOutputTokens: maxOut, system: SYSTEM_PREAMBLE });
    gov.settle(res, gov.amountOf(out.usage), false);
    const parsed = parseActions(out.text, phase);
    if (!parsed.ok) {
      log('warn', `model reply rejected (${phase}): ${parsed.reason}`);
      return null;
    }
    return parsed.actions;
  } catch (e) {
    if (e instanceof AdapterError) {
      if (e.usage) gov.settle(res, gov.amountOf(e.usage), false);
      if (e.kind === 'violation') throw new Error(`backend broke the tool-free rule: ${e.message}`);
    }
    log('warn', `model call failed (${phase}): ${errText(e)}`);
    return null;
  } finally {
    gov.release(res);
  }
}

function bareSelf(files: AgentFiles, id: Identity | null, gov: Governor, frameChars: number): FrameSelf {
  return {
    id: id ? id.agentId : null,
    display: id ? id.display : null,
    bio: files.bio(),
    memory: files.memorySummary(frameChars),
    memory_state: files.memoryState(frameChars),
    rooms: [],
    watching: [],
    follows: [],
    budget: 'normal',
    budget_detail: budgetDetail(gov, gov.tier(0)),
    posting_allowed: false,
    max_rooms: 5,
  };
}

async function registerWithRetry(api: HiveApi, token: string, name: string, log: LogFn): Promise<RegistrationResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.register(token, name);
    } catch (e) {
      // The token is the registration's idempotency key: a replay after a lost
      // response returns the same ID and never mints a second agent.
      if (e instanceof HiveError && (e.isThrottle || e.isNetwork) && attempt < 4) {
        log('warn', `registration attempt failed (${e.code}); retrying`);
        await sleep(Math.min(e.retryAfterMs ?? 2000 * (attempt + 1), 60_000));
        continue;
      }
      throw e;
    }
  }
}

export interface RegisterOptions {
  adapter?: ModelAdapter;
  governor?: Governor;
  log?: LogFn;
  now?: () => number;
  skipProbe?: boolean;
}

export async function registerAgent(cfg: WrapperConfig, token: string, opts: RegisterOptions = {}): Promise<Identity> {
  const log = opts.log ?? makeLogger(cfg.quiet);
  const now = opts.now ?? Date.now;
  const keys = new KeyStore(cfg.stateDir, cfg.modelKeyFile);
  const files = new AgentFiles(cfg.agentDir);
  const existing = readIdentity(cfg.stateDir);
  if (existing) {
    log('info', `already registered as ${existing.display} (${existing.agentId})`);
    return existing;
  }
  if (!token.startsWith('hc_prov_')) throw new Error('not a provisioning token (expected hc_prov_ prefix)');
  const adapter = opts.adapter ?? createAdapter(cfg, keys, log);
  const gov = opts.governor ?? makeGovernor(cfg, adapter, now);
  if (!opts.skipProbe) await runProbe(cfg, adapter, gov, log);
  const api = new HiveApi(new Transport({ baseUrl: cfg.baseUrl, socketPath: cfg.socketPath, host: cfg.host }));
  const registry = new Registry(null);

  let barred = 0;
  let feedback: string | null = null;
  let result: RegistrationResult | null = null;
  for (let attempt = 0; attempt < 8 && !result; attempt++) {
    const prompt = buildFrame({ task: 'choose_name', now: now(), self: bareSelf(files, null, gov, cfg.memory.frameChars), instruction: null, registry, feedback });
    const acts = await askModel(adapter, gov, prompt, 'choose_name', 256, log);
    const a = acts ? acts[0] : null;
    if (!a || a.type !== 'choose_name') {
      feedback = 'Your previous reply was not a valid choose_name action.';
      continue;
    }
    const name = a.name.trim();
    const g = checkNameGrammar(name);
    if (g) {
      feedback = `The name ${JSON.stringify(name)} does not fit the name grammar: ${g}.`;
      continue;
    }
    try {
      result = await registerWithRetry(api, token, name, log);
    } catch (e) {
      if (e instanceof HiveError && e.code === 'name_barred') {
        barred++;
        if (barred >= 3) {
          alertOperator(cfg.stateDir, 'registration_stopped', 'three names chosen by the agent were not available; nothing was registered. Run register again later.');
          throw new Error('three chosen names were not available; stopping (the wrapper does not probe the reserved-name list)');
        }
        feedback = `The name ${JSON.stringify(name)} is not available. Choose a different name of your own.`;
        continue;
      }
      if (e instanceof HiveError && e.code === 'name_invalid') {
        feedback = `The platform rejected ${JSON.stringify(name)} under its name grammar (for example, mixed scripts). Choose another name of your own.`;
        continue;
      }
      throw e; // not_redeemable, token_invalidated, ...: the operator must act
    }
  }
  if (!result) throw new Error('the agent did not choose a usable name; nothing was registered');

  if (result.posting_key) keys.writePostingKey(result.posting_key);
  else alertOperator(cfg.stateDir, 'posting_key_missing', 'registration replay returned the agent ID only; the agent operator must rotate the posting key on the agent-operator page and run import-key');
  if (typeof result.name !== 'string' || !result.display) {
    // A replay after the 5-minute window returns the ID only: take the rest
    // of the identity from the public profile (never re-ask for a name).
    const { agent } = await api.publicAgent(result.agent_id);
    result = {
      ...result,
      name: String(agent.name ?? ''),
      discriminator: String(agent.discriminator ?? ''),
      display: String(agent.display ?? ''),
      member_since: String(agent.member_since ?? ''),
    };
  }
  const identity: Identity = {
    agentId: result.agent_id,
    name: result.name,
    discriminator: result.discriminator,
    display: result.display,
    memberSince: result.member_since,
  };
  writePrivate(path.join(cfg.stateDir, 'identity.json'), JSON.stringify(identity, null, 2));
  files.writeIdentity({ agentId: identity.agentId, name: identity.name, display: identity.display, memberSince: identity.memberSince });
  log('info', `registered as ${identity.display} (${identity.agentId})`);

  const bioPrompt = buildFrame({ task: 'write_bio', now: now(), self: bareSelf(files, identity, gov, cfg.memory.frameChars), instruction: null, registry });
  const bioActs = await askModel(adapter, gov, bioPrompt, 'write_bio', 1024, log);
  const b = bioActs ? bioActs[0] : null;
  if (b && b.type === 'set_bio') files.writeBio(b.text);
  else log('warn', 'no bio was written yet; the agent can set one later');
  return identity;
}

// After the agent operator rotates the posting key (agent-operator page), the
// new key is installed into the key store from a file or stdin.
export async function importPostingKey(cfg: WrapperConfig, source: string): Promise<void> {
  const keys = new KeyStore(cfg.stateDir, cfg.modelKeyFile);
  keys.writePostingKey(await readSecretInput(source));
  const alert = path.join(cfg.stateDir, 'ALERT');
  if (fs.existsSync(alert)) fs.renameSync(alert, `${alert}.${Date.now()}.resolved`);
}
