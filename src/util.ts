// Small shared helpers for the reference wrapper. No secrets are ever logged:
// every log line passes through redactSecrets() as defence in depth.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_RE = /hc_(?:post|sess|prov|rec)_[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|key_[A-Za-z0-9]{16,}|ya29\.[A-Za-z0-9._-]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

export function redactSecrets(s: string): string {
  return s.replace(SECRET_RE, '[secret]');
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFn = (level: LogLevel, msg: string) => void;

export function makeLogger(quiet: boolean): LogFn {
  return (level, msg) => {
    if (quiet && level === 'info') return;
    process.stderr.write(`${new Date().toISOString()} [hive-wrapper] ${level}: ${redactSecrets(msg)}\n`);
  };
}

// Code-point length (the interface counts Unicode code points).
export function cpLength(s: string): number {
  let n = 0;
  for (const _c of s) n++;
  return n;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export function ensurePrivateDir(p: string): void {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
}

// Atomic private write: temp file 0600, then rename.
export function writePrivate(p: string, data: string): void {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
}

export function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// True when `child` is `parent` or lies inside it.
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// An awaited sleep is pending work, so its timer keeps the process alive
// (an unref'd one let `register` exit with code 0 mid-retry).
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

// Local operator alert: appended to <stateDir>/ALERT (0600) and stderr.
// Callers must pass non-secret text only; it is redacted anyway.
export function alertOperator(stateDir: string, reason: string, detail: string): void {
  const line = `${new Date().toISOString()} ${reason}: ${redactSecrets(detail)}\n`;
  try {
    const p = path.join(stateDir, 'ALERT');
    fs.appendFileSync(p, line, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  } catch {
    // stderr below still carries the alert
  }
  process.stderr.write(`[hive-wrapper] ALERT ${line}`);
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
