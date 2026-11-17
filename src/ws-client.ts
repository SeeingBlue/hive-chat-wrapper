// Minimal WebSocket client for the live stream (INTERFACE-V1 §3.3), built on
// node:http upgrade (works over a Unix socket too) and shared/ws-frame.ts.
// The client sends no data frames: only pongs and close.
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import {
  encodeFrame,
  encodeClose,
  decodeClose,
  FrameParser,
  MessageAssembler,
  acceptKey,
  newClientKey,
  OP_PING,
  OP_PONG,
  OP_CLOSE,
  OP_TEXT,
} from './shared/ws-frame.ts';
import { HiveError, errorFrom } from './transport.ts';
import type { Transport } from './transport.ts';

// Events: 'json' (obj), 'close' (code: number, reason: string).
export class WsConnection extends EventEmitter {
  private readonly socket: Socket;
  private head: Buffer;
  private readonly parser = new FrameParser(false, 1 << 20);
  private readonly assembler = new MessageAssembler(4 << 20);
  private closed = false;
  private closeSent = false;
  closeCode = 0;
  closeReason = '';

  private lastActivity = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;

  // Socket close/error handlers are attached at once: Node drops its own
  // error listener at the upgrade, so an early ECONNRESET would otherwise be
  // an uncaught 'error' event.
  constructor(socket: Socket, head: Buffer) {
    super();
    this.socket = socket;
    this.head = head;
    this.socket.on('close', () => this.finish(1006, 'connection lost'));
    this.socket.on('error', () => this.finish(1006, 'socket error'));
  }

  // Call after attaching listeners: processes any bytes that arrived with the
  // upgrade response, then streams. A close that happened before start() is
  // re-emitted so the caller always learns of it.
  start(): void {
    if (this.closed) {
      this.emit('close', this.closeCode, this.closeReason);
      return;
    }
    this.socket.setNoDelay(true);
    this.socket.on('data', (c: Buffer) => this.onData(c));
    // The server pings every 15 s. Silence for 45 s means a half-open
    // connection (sleep, network change): drop it so the session reconnects.
    this.lastActivity = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > 45_000) this.fail(1006, 'no traffic from server');
    }, 15_000);
    this.watchdog.unref();
    const h = this.head;
    this.head = Buffer.alloc(0);
    if (h.length > 0) this.onData(h);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.write(encodeClose(code, reason, true));
    }
    this.finish(code, reason);
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), 2000);
    t.unref();
  }

  private write(b: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(b);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close', code, reason);
  }

  private fail(code: number, reason: string): void {
    if (!this.closeSent) {
      this.closeSent = true;
      this.write(encodeClose(code, reason, true));
    }
    this.finish(code, reason);
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.lastActivity = Date.now();
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.fail(1002, 'protocol error');
      return;
    }
    for (const f of frames) {
      if (this.closed) return;
      if (f.opcode === OP_PING) {
        this.write(encodeFrame(OP_PONG, f.payload, true));
        continue;
      }
      if (f.opcode === OP_PONG) continue;
      if (f.opcode === OP_CLOSE) {
        const { code, reason } = decodeClose(f.payload);
        if (!this.closeSent) {
          this.closeSent = true;
          this.write(encodeClose(code === 1005 || code === 1006 ? 1000 : code, '', true));
        }
        this.finish(code, reason);
        this.socket.end();
        return;
      }
      let msg;
      try {
        msg = this.assembler.add(f);
      } catch {
        this.fail(1009, 'message too large');
        return;
      }
      if (!msg || msg.opcode !== OP_TEXT) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(msg.data.toString('utf8'));
      } catch {
        continue; // server frames are JSON; anything else is ignored
      }
      this.emit('json', obj);
    }
  }
}

export function connectWs(t: Transport, path: string, sessionToken: string, timeoutMs = 15_000): Promise<WsConnection> {
  const key = newClientKey();
  const target = t.target(path, 'GET', {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    Authorization: `Bearer ${sessionToken}`,
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const req = target.mod.request(target.options);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      req.destroy();
      reject(new HiveError(0, 'network_error', 'websocket connect timeout', null));
    }, timeoutMs);
    timer.unref();
    req.on('upgrade', (res: IncomingMessage, socket: Socket, head: Buffer) => {
      if (done) {
        socket.destroy();
        return;
      }
      done = true;
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        reject(new HiveError(0, 'network_error', 'bad websocket accept key', null));
        return;
      }
      resolve(new WsConnection(socket, head));
    });
    req.on('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        if (chunks.length < 64) chunks.push(c);
      });
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        let json: unknown = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = null;
        }
        reject(errorFrom(res.statusCode ?? 0, json, res.headers['retry-after']));
      });
    });
    req.on('error', (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new HiveError(0, 'network_error', e.message, null));
    });
    req.end();
  });
}
