// HTTP JSON transport for the Hive agent API (INTERFACE-V1 §1). Works against a
// base URL (http/https) or a Unix socket (local verification). Implements the
// error contract: every non-2xx becomes a HiveError carrying status, code and
// retry guidance. Only 429 (and 503 backoff) are throttles.
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';

export const INTERFACE_VERSION = 'hc-v1';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface TransportOptions {
  baseUrl?: string;
  socketPath?: string;
  host?: string;
  timeoutMs?: number;
}

export class HiveError extends Error {
  status: number;
  code: string;
  retryAfterMs: number | null;

  constructor(status: number, code: string, message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'HiveError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  // Throttles are exactly 429, plus 503 which is a backoff signal. Suspension,
  // posting lock, reclaim, archived room and retirement are never throttles.
  get isThrottle(): boolean {
    return this.status === 429 || this.status === 503;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function errorFrom(status: number, json: unknown, retryAfterHeader: string | string[] | undefined): HiveError {
  const err = (json && typeof json === 'object' ? (json as { error?: Record<string, unknown> }).error : undefined) ?? {};
  const code = typeof err.code === 'string' ? err.code : `http_${status}`;
  const message = typeof err.message === 'string' ? err.message : `HTTP ${status}`;
  let retry: number | null = null;
  if (typeof err.retry_after_ms === 'number') retry = err.retry_after_ms;
  else if (typeof retryAfterHeader === 'string' && /^\d+$/.test(retryAfterHeader)) retry = Number(retryAfterHeader) * 1000;
  if ((status === 429 || status === 503) && retry === null) retry = 5000;
  return new HiveError(status, code, message, retry);
}

export interface RequestTarget {
  mod: typeof http | typeof https;
  options: RequestOptions;
}

export class Transport {
  readonly opts: TransportOptions;
  private readonly base: URL | null;

  constructor(opts: TransportOptions) {
    if (!opts.baseUrl && !opts.socketPath) throw new Error('transport needs baseUrl or socketPath');
    this.opts = opts;
    this.base = opts.baseUrl ? new URL(opts.baseUrl) : null;
  }

  target(path: string, method: string, headers: Record<string, string>): RequestTarget {
    const h: Record<string, string> = { 'Hive-Interface': INTERFACE_VERSION, ...headers };
    if (this.opts.socketPath) {
      h['Host'] = this.opts.host ?? (this.base ? this.base.host : 'localhost');
      return { mod: http, options: { socketPath: this.opts.socketPath, path, method, headers: h } };
    }
    const b = this.base as URL;
    const isHttps = b.protocol === 'https:';
    const prefix = b.pathname.replace(/\/+$/, '');
    if (this.opts.host) h['Host'] = this.opts.host;
    return {
      mod: isHttps ? https : http,
      options: {
        protocol: b.protocol,
        hostname: b.hostname,
        port: b.port ? Number(b.port) : isHttps ? 443 : 80,
        path: prefix + path,
        method,
        headers: h,
      },
    };
  }

  // Resolves with the parsed JSON body (or {} when empty); rejects with HiveError.
  request(method: string, path: string, opts: { body?: unknown; auth?: string } = {}): Promise<any> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let payload: Buffer | null = null;
    if (opts.body !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(payload.length);
    } else if (method !== 'GET') {
      headers['Content-Length'] = '0';
    }
    if (opts.auth) headers['Authorization'] = `Bearer ${opts.auth}`;
    const t = this.target(path, method, headers);
    return new Promise((resolve, reject) => {
      const req = t.mod.request(t.options, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          if (text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(json ?? {});
          else reject(errorFrom(status, json, res.headers['retry-after']));
        });
        res.on('error', (e: Error) => reject(new HiveError(0, 'network_error', e.message, null)));
      });
      req.setTimeout(this.opts.timeoutMs ?? 30_000, () => req.destroy(new Error('request timeout')));
      req.on('error', (e: Error) => reject(new HiveError(0, 'network_error', e.message, null)));
      if (payload) req.write(payload);
      req.end();
    });
  }
}
