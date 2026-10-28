/**
 * One lamp's TCP connection: the plaintext ident, the nonce exchange and
 * AES-128-CBC requests. See docs/local-protocol.md.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import JuwelLocalError from './local-error.js';

/** Lamps answer within about 200 ms. */
const REPLY_TIMEOUT_MS = 5000;

const FRAME_IDENT = 0;
const FRAME_NONCE = 1;
const FRAME_ENCRYPTED = 2;

/** A decrypted message from a lamp, e.g. `{ type: 'status', ... }`. */
export type LocalMessage = { type?: string; error?: string[]; [key: string]: unknown };

/** Unit ids are MAC addresses; the cloud and the lamp agree on them up to case. */
export function normalizeUnitId(unitId: string): string {
  return unitId.toUpperCase();
}

function frame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(payload.length, 0);
  head.writeUInt16BE(type, 2);
  return Buffer.concat([head, payload]);
}

/** One lamp's connection. Emits 'ready' once encrypted, 'message' for unasked messages, and 'close'. */
export default class LampConnection extends EventEmitter {

  unitId: string | null = null;
  private buffer = Buffer.alloc(0);
  private readonly localNonce = crypto.randomBytes(8);
  private key: Buffer | null = null;
  private encipher: crypto.Cipheriv | null = null;
  private decipher: crypto.Decipheriv | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { resolve: (msg: LocalMessage) => void; reject: (err: Error) => void } | null = null;

  constructor(private readonly socket: net.Socket, private readonly keyFor: (unitId: string) => Buffer | undefined) {
    super();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.pending?.reject(new JuwelLocalError('The lamp closed the connection'));
      this.pending = null;
      this.emit('close');
    });
  }

  /** False once the connection is closed or being closed. */
  get isOpen(): boolean {
    return !this.socket.destroyed;
  }

  get address(): string {
    return this.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
  }

  close() {
    this.socket.destroy();
  }

  /** Send one request and wait for its reply. Requests are queued: replies carry no id. */
  send(message: object): Promise<LocalMessage> {
    const result = this.queue.then(() => this.exchange(message));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private exchange(message: object): Promise<LocalMessage> {
    if (this.encipher === null || this.socket.destroyed) {
      return Promise.reject(new JuwelLocalError('Not connected to the lamp'));
    }

    // Plaintext is padded with spaces to the AES block size; the lamp trims it.
    const text = Buffer.from(JSON.stringify(message), 'utf8');
    const plain = Buffer.concat([text, Buffer.alloc((16 - (text.length % 16)) % 16, 0x20)]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        // A late reply would be taken for the next request's, so start over.
        this.close();
        reject(new JuwelLocalError(`The lamp did not answer within ${REPLY_TIMEOUT_MS / 1000}s`));
      }, REPLY_TIMEOUT_MS);

      this.pending = {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.socket.write(frame(FRAME_ENCRYPTED, this.encipher!.update(plain)));
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt16BE(0);
      if (this.buffer.length < 4 + length) return;
      const type = this.buffer.readUInt16BE(2);
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        this.onFrame(type, payload);
      } catch {
        this.close();
        return;
      }
    }
  }

  private onFrame(type: number, payload: Buffer) {
    if (type === FRAME_IDENT) {
      const { ident } = JSON.parse(payload.toString('utf8')) as { ident?: { unit_id?: string } };
      if (typeof ident?.unit_id !== 'string') throw new Error('ident without unit_id');
      this.unitId = normalizeUnitId(ident.unit_id);
      this.key = this.keyFor(this.unitId) ?? null;
      // Not one of our lamps: let it go so it is not kept waiting.
      if (this.key === null) throw new Error('unknown lamp');
      this.socket.write(frame(FRAME_NONCE, this.localNonce));
    } else if (type === FRAME_NONCE && this.key !== null) {
      // Each direction's IV starts with its sender's nonce. The CBC chain runs
      // on across frames, so the ciphers live as long as the connection.
      this.encipher = crypto.createCipheriv('aes-128-cbc', this.key, Buffer.concat([this.localNonce, payload]))
        .setAutoPadding(false);
      this.decipher = crypto.createDecipheriv('aes-128-cbc', this.key, Buffer.concat([payload, this.localNonce]))
        .setAutoPadding(false);
      this.emit('ready');
    } else if (type === FRAME_ENCRYPTED && this.decipher !== null) {
      const message = JSON.parse(this.decipher.update(payload).toString('utf8').trimEnd()) as LocalMessage;
      const { pending } = this;
      this.pending = null;
      if (pending) pending.resolve(message);
      else this.emit('message', message);
    }
  }

}
