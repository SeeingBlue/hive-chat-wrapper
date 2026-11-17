// Minimal RFC 6455 frame codec shared by the platform (server side) and the
// reference wrapper (client side). No extensions, no compression.
import { createHash, randomBytes } from 'node:crypto';

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
}

export function newClientKey(): string {
  return randomBytes(16).toString('base64');
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  if (mask) headerLen += 4;
  const out = Buffer.alloc(headerLen + len);
  out[0] = 0x80 | (opcode & 0x0f);
  let off = 2;
  if (len < 126) {
    out[1] = len;
  } else if (len <= 0xffff) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
    off = 4;
  } else {
    out[1] = 127;
    out.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    out.writeUInt32BE(len >>> 0, 6);
    off = 10;
  }
  if (mask) {
    out[1] |= 0x80;
    const key = randomBytes(4);
    key.copy(out, off);
    off += 4;
    for (let i = 0; i < len; i++) out[off + i] = payload[i] ^ key[i & 3];
  } else {
    payload.copy(out, off);
  }
  return out;
}

export function encodeText(text: string, mask: boolean): Buffer {
  return encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'), mask);
}

export function encodeClose(code: number, reason: string, mask: boolean): Buffer {
  const r = Buffer.from(reason.slice(0, 100), 'utf8');
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encodeFrame(OP_CLOSE, p, mask);
}

export function decodeClose(payload: Buffer): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1005, reason: '' };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

// Incremental parser. `requireMask` is true on the server (client frames must
// be masked) and false on the client (server frames must not be masked).
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly requireMask: boolean;
  private readonly maxPayload: number;

  constructor(requireMask: boolean, maxPayload: number) {
    this.requireMask = requireMask;
    this.maxPayload = maxPayload;
  }

  // Returns parsed frames; throws Error on protocol violations.
  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      if ((b0 & 0x70) !== 0) throw new Error('reserved bits set');
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (masked !== this.requireMask) throw new Error('mask mismatch');
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const hi = this.buf.readUInt32BE(2);
        const lo = this.buf.readUInt32BE(6);
        if (hi > 0x1fffff) throw new Error('frame too large');
        len = hi * 0x100000000 + lo;
        off = 10;
      }
      if (len > this.maxPayload) throw new Error('frame too large');
      if (opcode >= 0x8 && (len > 125 || !fin)) throw new Error('bad control frame');
      let key: Buffer | null = null;
      if (masked) {
        if (this.buf.length < off + 4) break;
        key = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) break;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (key) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      this.buf = this.buf.subarray(off + len);
      frames.push({ fin, opcode, payload });
    }
    return frames;
  }
}

// Reassembles fragmented data messages. Returns a complete text/binary
// message, or null when more fragments are needed.
export class MessageAssembler {
  private parts: Buffer[] = [];
  private opcode = 0;
  private size = 0;
  private readonly maxMessage: number;

  constructor(maxMessage: number) {
    this.maxMessage = maxMessage;
  }

  add(frame: Frame): { opcode: number; data: Buffer } | null {
    if (frame.opcode === OP_CONT) {
      if (this.parts.length === 0) throw new Error('unexpected continuation');
    } else {
      if (this.parts.length !== 0) throw new Error('expected continuation');
      this.opcode = frame.opcode;
    }
    this.size += frame.payload.length;
    if (this.size > this.maxMessage) throw new Error('message too large');
    this.parts.push(frame.payload);
    if (!frame.fin) return null;
    const data = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
    const opcode = this.opcode;
    this.parts = [];
    this.size = 0;
    return { opcode, data };
  }
}
