/**
 * Local (LAN) client for JUWEL lamps, which run Klyqa firmware. See
 * docs/local-protocol.md for the protocol.
 *
 * In short: a `QCX-SYN;<unit id>` broadcast on UDP 2222 makes that lamp
 * connect back to us on TCP 3333. Each connection starts with a plaintext ident naming the
 * lamp, then both sides swap 8-byte nonces and switch to AES-128-CBC with the
 * lamp's aesKey. One connection per lamp is kept open and carries one request
 * at a time.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import LampConnection, { normalizeUnitId, type LocalMessage } from './local-connection.js';
import JuwelLocalError from './local-error.js';

export { JuwelLocalError, normalizeUnitId, type LocalMessage };

const DISCOVERY_PORT = 2222;
const CONNECT_PORT = 3333;
/**
 * The SYN names the lamp: a plain `QCX-SYN` is ignored by every lamp except
 * the one addressed last, by us or by the MyJUWEL app.
 */
const synFor = (unitId: string) => `QCX-SYN;${unitId}`;

/** How often the SYN is repeated while a lamp is awaited. The phone app does the same. */
const SYN_INTERVAL_MS = 1000;

/** How long to wait for a lamp to connect. A lamp answers a SYN within about a second. */
const DISCOVERY_TIMEOUT_MS = 10_000;

type Logger = (...args: unknown[]) => void;

/**
 * The app's single local endpoint. It owns UDP 2222 and TCP 3333, which only
 * one process per host can bind, and keeps one connection per known lamp.
 *
 * Emits 'message' (unitId, message) for messages a lamp sends unasked.
 */
export class JuwelLocal extends EventEmitter {

  private readonly keys = new Map<string, Buffer>();
  private readonly lamps = new Map<string, LampConnection>();
  private readonly waiting = new Map<string, Set<(lamp: LampConnection) => void>>();
  private udp: dgram.Socket | null = null;
  private server: net.Server | null = null;
  private starting: Promise<void> | null = null;
  private synTimer: NodeJS.Timeout | null = null;

  constructor(private readonly log: Logger) {
    super();
  }

  /** Allow connections from a lamp. `aesKey` is the 32-character hex key from MyJUWEL. */
  addLamp(unitId: string, aesKey: string) {
    this.keys.set(normalizeUnitId(unitId), Buffer.from(aesKey, 'hex'));
  }

  removeLamp(unitId: string) {
    const id = normalizeUnitId(unitId);
    this.keys.delete(id);
    this.lamps.get(id)?.close();
  }

  /**
   * Send one request to a lamp and return its reply, connecting first when
   * needed. A reply that reports errors, such as a manual write while the
   * schedule runs, is rejected with them.
   */
  async request(unitId: string, message: object): Promise<LocalMessage> {
    const lamp = await this.connection(normalizeUnitId(unitId));
    const reply = await lamp.send(message);
    if (Array.isArray(reply.error) && reply.error.length > 0) {
      throw new JuwelLocalError(`The lamp refused the request: ${reply.error.join('; ')}`);
    }
    return reply;
  }

  close() {
    this.stopSyn();
    for (const lamp of this.lamps.values()) lamp.close();
    this.lamps.clear();
    this.udp?.close();
    this.server?.close();
    this.udp = null;
    this.server = null;
    this.starting = null;
  }

  private async connection(unitId: string): Promise<LampConnection> {
    const open = this.lamps.get(unitId);
    if (open) return open;
    if (!this.keys.has(unitId)) throw new JuwelLocalError(`No key for lamp ${unitId}`);

    await this.start();
    return new Promise((resolve, reject) => {
      const waiters = this.waiting.get(unitId) ?? new Set();
      this.waiting.set(unitId, waiters);

      let timer: NodeJS.Timeout | null = null;
      const found = (lamp: LampConnection) => {
        if (timer !== null) clearTimeout(timer);
        resolve(lamp);
      };
      timer = setTimeout(() => {
        waiters.delete(found);
        this.syncSyn();
        reject(new JuwelLocalError('The lamp was not found on the local network'));
      }, DISCOVERY_TIMEOUT_MS);

      waiters.add(found);
      this.syncSyn();
    });
  }

  private start(): Promise<void> {
    this.starting ??= this.bind().catch((err) => {
      this.close();
      throw new JuwelLocalError(`Could not open the local ports: ${err instanceof Error ? err.message : err}`);
    });
    return this.starting;
  }

  private async bind() {
    const server = net.createServer((socket) => this.onSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(CONNECT_PORT, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.log('Local TCP server error:', err.message));

    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = udp;
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(DISCOVERY_PORT, () => {
        udp.off('error', reject);
        udp.setBroadcast(true);
        resolve();
      });
    });
    // Our own SYNs and the lamps' ACKs land here; the TCP connection is what counts.
    udp.on('message', () => undefined);
    udp.on('error', (err) => this.log('Local UDP socket error:', err.message));
  }

  private onSocket(socket: net.Socket) {
    const lamp = new LampConnection(socket, (unitId) => this.keys.get(unitId));

    lamp.once('ready', () => {
      const unitId = lamp.unitId!;
      const previous = this.lamps.get(unitId);
      this.lamps.set(unitId, lamp);
      // A lamp dials in again on every SYN for it; the newest connection wins.
      if (previous && previous !== lamp) previous.close();
      this.log(`Connected to lamp ${unitId} at ${lamp.address}`);

      const waiters = this.waiting.get(unitId);
      this.waiting.delete(unitId);
      this.syncSyn();
      for (const found of waiters ?? []) found(lamp);
    });

    lamp.on('message', (message: LocalMessage) => this.emit('message', lamp.unitId, message));
    lamp.once('close', () => {
      if (lamp.unitId !== null && this.lamps.get(lamp.unitId) === lamp) {
        this.lamps.delete(lamp.unitId);
        this.log(`Lost the connection to lamp ${lamp.unitId}`);
      }
    });
  }

  /** Broadcast a SYN for each awaited lamp, and stop once none is awaited. */
  private syncSyn() {
    if (this.awaitedLamps().length === 0) {
      this.stopSyn();
      return;
    }
    if (this.synTimer !== null) return;

    const send = () => {
      for (const unitId of this.awaitedLamps()) {
        this.udp?.send(synFor(unitId), DISCOVERY_PORT, '255.255.255.255', (err) => {
          if (err) this.log('Could not broadcast the lamp discovery:', err.message);
        });
      }
    };
    send();
    this.synTimer = setInterval(send, SYN_INTERVAL_MS);
  }

  private awaitedLamps(): string[] {
    return [...this.waiting].filter(([, waiters]) => waiters.size > 0).map(([unitId]) => unitId);
  }

  private stopSyn() {
    if (this.synTimer !== null) clearInterval(this.synTimer);
    this.synTimer = null;
  }

}
