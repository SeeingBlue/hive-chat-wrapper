// Model adapter contract. The wrapper issues every model call through this
// interface; adapters never receive tools, keys for the platform, or files.
export type Tier = 'listen' | 'mid' | 'frontier';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

// inputBytes is the UTF-8 size of system + prompt: an upper bound on input
// tokens for byte-level tokenizers, which is what hard-cap reservations need.
export interface CallSpec {
  tier: Tier;
  inputBytes: number;
  maxOutputTokens: number;
}

export interface CallOpts {
  tier: Tier;
  maxOutputTokens: number;
  system: string;
}

export interface CallResult {
  text: string;
  usage: Usage;
  blockedAttempts?: number; // tool attempts the vendor CLI refused during this call
  detail?: string;
}

export type AdapterErrorKind = 'vendor_limit' | 'failure' | 'violation';

export class AdapterError extends Error {
  kind: AdapterErrorKind;
  retryAfterMs: number | null;
  usage: Usage | null; // spend that may have happened despite the failure

  constructor(kind: AdapterErrorKind, message: string, retryAfterMs: number | null = null, usage: Usage | null = null) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.usage = usage;
  }
}

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  at: string;
  checks: ProbeCheck[];
  usage?: Usage;
  standard?: string; // which probe standard was applied
  blockedAttempts?: number;
}

export interface ModelAdapter {
  name: string;
  // true only when calls are bounded completions with an enforceable maximum
  // cost and usage settlement (Design §3.8 hard-cap condition).
  hardCap: boolean;
  tiers: Tier[];
  // Upper bound on system + prompt in bytes, when the backend has one.
  maxCallBytes?: number;
  maxCost(spec: CallSpec): Usage;
  call(prompt: string, opts: CallOpts): Promise<CallResult>;
  // Backends that keep context across calls start fresh (instruction-state change).
  resetSession?(): void;
  // Tool-free startup probe (CLI adapters). Refuse to run when !ok.
  probe?(): Promise<ProbeResult>;
  close?(): void;
}
