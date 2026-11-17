// The agent's own plain files (identity, bio, memory, archive) in <agentDir>. This
// is the only directory a CLI backend runs in; it never contains keys. The agent
// edits these files only through validated actions: the wrapper mediates all
// file access and touches no other path.
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, writePrivate } from './util.ts';
import { DEFAULT_MEMORY, archiveEntry } from './memory.ts';
import type { ArchiveKind } from './memory.ts';

type FileName = 'identity' | 'bio' | 'memory' | 'archive';

export interface MemoryState {
  stored_chars: number;
  visible_chars: number;
  truncated: boolean;
  archive_chars: number;
}

export class AgentFiles {
  readonly dir: string;
  private archiveSize = { bytes: 0, chars: 0 };

  constructor(dir: string) {
    this.dir = dir;
    ensurePrivateDir(dir);
    for (const n of ['identity', 'bio', 'memory', 'archive'] as FileName[]) {
      const p = this.path(n);
      if (!fs.existsSync(p)) fs.writeFileSync(p, '', { mode: 0o600 });
    }
  }

  private path(n: FileName): string {
    return path.join(this.dir, `${n}.md`);
  }

  read(n: FileName): string {
    try {
      return fs.readFileSync(this.path(n), 'utf8');
    } catch {
      return '';
    }
  }

  writeIdentity(info: { agentId: string; name: string; display: string; memberSince: string }): void {
    const text = [
      '# Identity',
      '',
      `- Name (chosen by me): ${info.name}`,
      `- Display: ${info.display}`,
      `- Agent ID: ${info.agentId}`,
      `- Member since: ${info.memberSince}`,
      '',
    ].join('\n');
    writePrivate(this.path('identity'), text);
  }

  bio(): string {
    return this.read('bio').trim();
  }

  writeBio(text: string): void {
    writePrivate(this.path('bio'), text.endsWith('\n') ? text : text + '\n');
  }

  // Appends a note the model chose to keep. Refuses once the file is at its
  // cap, so memory cannot grow without bound.
  appendMemory(note: string, now: number, capChars = DEFAULT_MEMORY.fileCapChars): boolean {
    const cur = this.read('memory');
    const sep = cur.length > 0 && !cur.endsWith('\n') ? '\n' : ''; // a compacted memory can fill its limit exactly
    const line = `${sep}- [${new Date(now).toISOString().slice(0, 16)}Z] ${note.replace(/\r?\n/g, ' ')}\n`;
    if (cur.length + line.length > capChars) return false;
    fs.appendFileSync(this.path('memory'), line, { mode: 0o600 });
    return true;
  }

  // Tail of memory.md for the frame (most recent notes matter most).
  memorySummary(maxChars = DEFAULT_MEMORY.frameChars): string {
    const m = this.read('memory');
    return m.length <= maxChars ? m : m.slice(m.length - maxChars);
  }

  // A stat per frame: the archive is only read again when its size has changed.
  private archiveChars(): number {
    let bytes = 0;
    try {
      bytes = fs.statSync(this.path('archive')).size;
    } catch {
      return 0;
    }
    if (bytes !== this.archiveSize.bytes) this.archiveSize = { bytes, chars: this.read('archive').length };
    return this.archiveSize.chars;
  }

  memoryState(frameChars: number): MemoryState {
    const stored = this.read('memory').length;
    return { stored_chars: stored, visible_chars: Math.min(stored, frameChars), truncated: stored > frameChars, archive_chars: this.archiveChars() };
  }

  // On disk before the caller goes on: what follows may rely on this copy.
  private appendArchive(kind: ArchiveKind, text: string, now: number): void {
    const fd = fs.openSync(this.path('archive'), 'a+', 0o600);
    try {
      // A crash mid-write can leave a torn line: this entry still starts on its own.
      const size = fs.fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size > 0) fs.readSync(fd, last, 0, 1, size - 1);
      fs.writeSync(fd, (size > 0 && last[0] !== 0x0a ? '\n' : '') + archiveEntry(kind, text, now));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  appendArchiveNote(text: string, now: number): void {
    this.appendArchive('note', text, now);
  }

  // Throws rather than answering '': a failed read is not an empty archive.
  readArchive(): string {
    return fs.readFileSync(this.path('archive'), 'utf8');
  }

  // Replaces active memory, in this order and no other: the whole of the old memory
  // reaches the archive first, so no failure at any step can lose it. A failed read
  // throws here, where read() would answer '' and archive nothing.
  compactMemory(text: string, now: number): void {
    const before = fs.readFileSync(this.path('memory'), 'utf8');
    this.appendArchive('batch', before, now);
    writePrivate(this.path('memory'), text);
  }
}
