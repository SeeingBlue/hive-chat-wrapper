// Key custody (Design §7.5): the posting key and any model API key live in
// <stateDir>/keys (0700 dir, 0600 files), outside every model-readable file.
// The recovery secret never enters the wrapper. Key values are never logged.
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, writePrivate } from './util.ts';
import { isWindows } from './platform.ts';

// POSIX only. Windows has no group/other mode bits (Node reports a synthetic
// mode, 0666 for any writable file), so the check would refuse every key file
// there; on Windows the file's NTFS ACL is what keeps it private.
function assertPrivate(p: string): void {
  if (isWindows()) return;
  const st = fs.statSync(p);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`key file ${p} is readable by group/others; run: chmod 600 ${p}`);
  }
}

export class KeyStore {
  readonly dir: string;
  readonly postingKeyPath: string;
  readonly modelKeyPath: string;

  constructor(stateDir: string, modelKeyFile?: string) {
    ensurePrivateDir(stateDir);
    this.dir = path.join(stateDir, 'keys');
    ensurePrivateDir(this.dir);
    this.postingKeyPath = path.join(this.dir, 'posting.key');
    this.modelKeyPath = modelKeyFile ?? path.join(this.dir, 'model.key');
  }

  hasPostingKey(): boolean {
    return fs.existsSync(this.postingKeyPath);
  }

  readPostingKey(): string | null {
    if (!fs.existsSync(this.postingKeyPath)) return null;
    assertPrivate(this.postingKeyPath);
    const k = fs.readFileSync(this.postingKeyPath, 'utf8').trim();
    return k.startsWith('hc_post_') ? k : null;
  }

  writePostingKey(key: string): void {
    const k = key.trim();
    if (!k.startsWith('hc_post_')) throw new Error('not a posting key (expected hc_post_ prefix)');
    writePrivate(this.postingKeyPath, k + '\n');
  }

  readModelKey(): string | null {
    if (!fs.existsSync(this.modelKeyPath)) return null;
    assertPrivate(this.modelKeyPath);
    const k = fs.readFileSync(this.modelKeyPath, 'utf8').trim();
    return k.length > 0 ? k : null;
  }
}

// Reads a provisioning token (or a rotated posting key) from a file path, or
// from stdin when the source is "-". Never deletes the source: the operator
// created it and decides what to do with it.
export async function readSecretInput(source: string): Promise<string> {
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return fs.readFileSync(source, 'utf8').trim();
}
