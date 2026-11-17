// Deterministic scripted adapter for tests and local verification. Declares
// hard-cap behaviour: fixed, known cost per call (maxCost equals actual cost).
import type { CallOpts, CallResult, CallSpec, ModelAdapter, Tier, Usage } from './types.ts';

export type MockResponder = (prompt: string, opts: CallOpts, index: number) => string | Promise<string>;

export interface MockAdapterConfig {
  kind?: string;
  name?: string; // the name the default responder chooses at registration
  bio?: string;
  costs?: Partial<Record<Tier, Usage>>;
}

const DEFAULT_COSTS: Record<Tier, Usage> = {
  listen: { inputTokens: 1000, outputTokens: 100, costUsd: 0.001 },
  mid: { inputTokens: 2000, outputTokens: 200, costUsd: 0.01 },
  frontier: { inputTokens: 4000, outputTokens: 400, costUsd: 0.05 },
};

const SILENCE = '{"actions":[{"type":"silence"}]}';

function actions(list: unknown[]): string {
  return JSON.stringify({ actions: list });
}

// Default behaviour: picks a name and bio, joins the starter room, replies to
// items flagged as mentioning or replying to it, and sends drafts unchanged.
export function defaultMockResponder(name = 'Mockingbird', bio = "A test agent driven by the reference wrapper's scripted mock backend."): MockResponder {
  return (prompt: string): string => {
    let doc: any;
    try {
      doc = JSON.parse(prompt);
    } catch {
      return SILENCE;
    }
    switch (doc?.task) {
      case 'choose_name':
        return actions([{ type: 'choose_name', name }]);
      case 'write_bio':
        return actions([{ type: 'set_bio', text: bio }]);
      case 'directory': {
        if ((doc.self?.rooms ?? []).length > 0) return SILENCE;
        const list: any[] = Array.isArray(doc.directory) ? doc.directory : [];
        const pick = list.find((r) => r.starter) ?? list[0];
        return pick ? actions([{ type: 'join', room_id: pick.id, mode: 'attentive' }]) : SILENCE;
      }
      case 'chunk':
      case 'draft': {
        if (!doc.self?.posting_allowed || !doc.room) return SILENCE;
        const items: any[] = Array.isArray(doc.items) ? doc.items : [];
        const hit = [...items].reverse().find((it) => it.kind === 'message' && !it.author?.is_you && ['mention', 'reply', 'direct_question'].includes(it.flag));
        if (!hit) return SILENCE;
        return actions([{ type: 'send', room_id: doc.room.id, text: `Hello ${String(hit.author?.display ?? 'there')}, I read your message.`, reply_to: hit.id }]);
      }
      case 'recheck':
        return actions([{ type: 'decide', decision: 'send' }]);
      default:
        return SILENCE;
    }
  };
}

export class MockAdapter implements ModelAdapter {
  readonly name = 'mock';
  readonly hardCap = true;
  readonly tiers: Tier[] = ['listen', 'mid', 'frontier'];
  readonly costs: Record<Tier, Usage>;
  readonly calls: Array<{ prompt: string; opts: CallOpts }> = [];
  resets = 0;
  private readonly script: string[];
  private readonly responder: MockResponder;

  constructor(cfg: MockAdapterConfig = {}, responder?: MockResponder, script: string[] = []) {
    this.costs = { ...DEFAULT_COSTS, ...(cfg.costs ?? {}) };
    this.responder = responder ?? defaultMockResponder(cfg.name, cfg.bio);
    this.script = [...script];
  }

  maxCost(spec: CallSpec): Usage {
    return { ...this.costs[spec.tier] };
  }

  async call(prompt: string, opts: CallOpts): Promise<CallResult> {
    const index = this.calls.length;
    this.calls.push({ prompt, opts });
    const scripted = this.script.shift();
    const text = scripted !== undefined ? scripted : await this.responder(prompt, opts, index);
    return { text, usage: { ...this.costs[opts.tier] } };
  }

  resetSession(): void {
    this.resets++;
  }
}
