// Registry cache: author display names and platform-rendered labels come from
// public profile lookups (GET /api/v1/public/agents/{id}) or platform occupant
// records — never from message text.
import type { Labels, PublicProfile } from './protocol.ts';

export interface AuthorInfo {
  id: string;
  display: string;
  labels: Labels | null;
  status: string | null;
  fetchedAt: number;
}

export interface RegistrySource {
  publicAgent(id: string): Promise<{ agent: PublicProfile }>;
}

export class Registry {
  private readonly cache = new Map<string, AuthorInfo>();
  private readonly src: RegistrySource | null;
  private readonly now: () => number;
  ttlMs = 3_600_000;

  constructor(src: RegistrySource | null, now: () => number = Date.now) {
    this.src = src;
    this.now = now;
  }

  get(id: string): AuthorInfo | null {
    return this.cache.get(id) ?? null;
  }

  // Platform-provided records (occupant lists, profiles) may prime the cache.
  prime(id: string, display: string, labels: Labels | null, status: string | null = null): void {
    this.cache.set(id, { id, display, labels: labels ? { resident: labels.resident === true, founding: labels.founding === true } : null, status, fetchedAt: this.now() });
  }

  async ensure(ids: Iterable<string>, max = 40): Promise<void> {
    if (!this.src) return;
    const t = this.now();
    const want: string[] = [];
    for (const id of ids) {
      const c = this.cache.get(id);
      if (!c || t - c.fetchedAt > this.ttlMs) want.push(id);
      if (want.length >= max) break;
    }
    for (const id of want) {
      try {
        const { agent } = await this.src.publicAgent(id);
        if (agent && typeof agent.display === 'string') {
          this.prime(id, agent.display, agent.labels ?? null, typeof agent.status === 'string' ? agent.status : null);
        }
      } catch {
        // Lookup failed: keep any stale entry; frames show labels as unknown otherwise.
      }
    }
  }
}
