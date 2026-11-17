// API-key adapter for the Anthropic Messages API (hard-cap: every call is a
// bounded completion the wrapper itself issues). max_tokens is always set and
// no `tools` parameter is ever sent. Model IDs and per-token prices are
// operator configuration; nothing here hard-codes a price.
//
// maxCost = input bound × input price + max_tokens × output price, where the
// input bound is the UTF-8 byte length of system + prompt (each token covers
// at least one byte) plus a small framing overhead.
import { AdapterError } from './types.ts';
import type { CallOpts, CallResult, CallSpec, ModelAdapter, Tier, Usage } from './types.ts';

export interface TierPrice {
  input: number; // USD per million input tokens
  output: number; // USD per million output tokens
}

export interface AnthropicConfig {
  kind: 'anthropic';
  apiBase?: string;
  anthropicVersion?: string;
  models: Partial<Record<Tier, string>>;
  pricesPerMTok: Partial<Record<Tier, TierPrice>>;
  timeoutMs?: number;
}

const FRAMING_OVERHEAD_TOKENS = 64;

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly name = 'anthropic';
  readonly hardCap = true;
  readonly tiers: Tier[];
  private readonly cfg: AnthropicConfig;
  #key: string;
  private readonly closer = new AbortController();

  // Stopping the wrapper aborts any request still in flight.
  close(): void {
    this.closer.abort();
  }

  constructor(cfg: AnthropicConfig, apiKey: string) {
    if (!cfg.models || typeof cfg.models.listen !== 'string') throw new Error('anthropic adapter: models.listen is required');
    const tiers: Tier[] = [];
    for (const t of ['listen', 'mid', 'frontier'] as Tier[]) {
      if (typeof cfg.models[t] !== 'string') continue;
      const p = cfg.pricesPerMTok?.[t];
      if (!p || !(n(p.input) > 0) || !(n(p.output) > 0)) {
        throw new Error(`anthropic adapter: pricesPerMTok.${t} {input, output} must be set by the operator (USD per million tokens)`);
      }
      tiers.push(t);
    }
    this.cfg = cfg;
    this.tiers = tiers;
    this.#key = apiKey;
  }

  private price(tier: Tier): TierPrice {
    const p = this.cfg.pricesPerMTok[tier];
    if (!p) throw new AdapterError('failure', `no price configured for tier ${tier}`);
    return p;
  }

  maxCost(spec: CallSpec): Usage {
    const p = this.price(this.tiers.includes(spec.tier) ? spec.tier : 'listen');
    const inputTokens = spec.inputBytes + FRAMING_OVERHEAD_TOKENS;
    const outputTokens = spec.maxOutputTokens;
    return { inputTokens, outputTokens, costUsd: (inputTokens * p.input + outputTokens * p.output) / 1e6 };
  }

  private usageOf(u: any, tier: Tier): Usage {
    const p = this.price(tier);
    const base = n(u?.input_tokens);
    const cacheWrite = n(u?.cache_creation_input_tokens);
    const cacheRead = n(u?.cache_read_input_tokens);
    const out = n(u?.output_tokens);
    // Cache writes are priced conservatively at 2x input (no cache_control is sent, so expect 0).
    const costUsd = ((base + cacheRead) * p.input + cacheWrite * p.input * 2 + out * p.output) / 1e6;
    return { inputTokens: base + cacheWrite + cacheRead, outputTokens: out, costUsd };
  }

  async call(prompt: string, opts: CallOpts): Promise<CallResult> {
    const model = this.cfg.models[opts.tier];
    if (!model) throw new AdapterError('failure', `no model configured for tier ${opts.tier}`);
    const bound = this.maxCost({
      tier: opts.tier,
      inputBytes: Buffer.byteLength(opts.system, 'utf8') + Buffer.byteLength(prompt, 'utf8'),
      maxOutputTokens: opts.maxOutputTokens,
    });
    const body = {
      model,
      max_tokens: opts.maxOutputTokens,
      system: opts.system,
      messages: [{ role: 'user', content: prompt }],
    };
    const base = (this.cfg.apiBase ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    let resp: Response;
    try {
      resp = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.#key,
          'anthropic-version': this.cfg.anthropicVersion ?? '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000), this.closer.signal]),
      });
    } catch (e) {
      // The request may have been processed: settle conservatively at the bound.
      throw new AdapterError('failure', `Messages API request failed (${e instanceof Error ? e.name : 'error'})`, null, bound);
    }
    if (!resp.ok) {
      let kind = '';
      try {
        const j: any = await resp.json();
        kind = typeof j?.error?.type === 'string' ? j.error.type : '';
      } catch {
        kind = '';
      }
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('retry-after'));
        throw new AdapterError('vendor_limit', `Messages API rate limited (${kind})`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000, null);
      }
      throw new AdapterError('failure', `Messages API HTTP ${resp.status} ${kind}`, null, null);
    }
    let json: any;
    try {
      json = await resp.json();
    } catch {
      throw new AdapterError('failure', 'Messages API returned invalid JSON', null, bound);
    }
    const usage = this.usageOf(json?.usage, opts.tier);
    let text = '';
    for (const block of Array.isArray(json?.content) ? json.content : []) {
      const t = block?.type;
      if (typeof t === 'string' && t.includes('tool')) throw new AdapterError('violation', `unexpected ${t} content block`, null, usage);
      if (t === 'text' && typeof block.text === 'string') text += block.text;
    }
    return { text, usage };
  }
}
