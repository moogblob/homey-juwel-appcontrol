/**
 * Minimal client for the MyJUWEL / qconnex cloud API.
 *
 * Endpoints and payload shapes are taken from the Python Home Assistant
 * integration at https://github.com/Melle79/juwel-appcontrol
 * (custom_components/juwel_appcontrol/api.py).
 *
 * Public request/response types live in ./types.ts and are re-exported here.
 */

import type {
  ChannelValues,
  CommandBody,
  DeviceState,
  FeederPreset,
  HeliaLuxState,
  JuwelCloudOptions,
  ManualLightOptions,
  Preset,
  ProductConfig,
  Settings,
  StatePayload,
} from './types.js';
import JuwelApiError from './api-error.js';
import JuwelAuthError from './auth-error.js';

export type * from './types.js';
export { JuwelAuthError, JuwelApiError };

export const API_HOST = 'https://app-api.prod.qconnex.io';
export const ENVIRONMENT_NAME = 'Juwel';
const TIMEOUT_MS = 20_000;

interface LoginResponse {
  accountToken?: string;
  accessToken?: string;
}

type HttpMethod = 'GET' | 'POST';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Percent (0..100) -> the cloud's 0..255 channel scale. */
function pctToByte(pct: number): number {
  return Math.round((clamp(pct, 0, 100) / 100) * 255);
}

/** The cloud's 0..255 channel scale -> percent (0..100). */
function byteToPct(byte: number): number {
  return Math.round((clamp(byte, 0, 255) / 255) * 100);
}

/**
 * Channel levels of a reported state in percent (0..100), the same scale as
 * Preset timeEvents and ManualLightOptions. Channels the state does not
 * report are omitted. Note that in "auto" mode these are the last manual
 * values, not the live curve; see HeliaLuxState.
 */
export function channelLevels(state: HeliaLuxState): Partial<ChannelValues> {
  const out: Partial<ChannelValues> = {};
  if (state.color) {
    out.red = byteToPct(state.color.red);
    out.green = byteToPct(state.color.green);
    out.blue = byteToPct(state.color.blue);
  }
  if (state.white) out.white = byteToPct(state.white.value);
  return out;
}

/**
 * The cloud preset id of the profile the lamp is running, or null when the
 * state does not say. `presets` maps the device's slots to cloud preset ids.
 */
export function activePresetId(state: HeliaLuxState): string | null {
  if (state.active_preset === undefined) return null;
  return state.presets?.find((p) => p.id === state.active_preset)?.name ?? null;
}

/**
 * Channel levels in percent (0..100) that a profile's daily curve gives at
 * `minute` after midnight, interpolated linearly between its time events and
 * wrapping around midnight. Returns null for a profile without time events.
 */
export function presetLevelsAt(preset: Preset, minute: number): ChannelValues | null {
  const events = [...preset.timeEvents].sort((a, b) => a.time - b.time);
  if (events.length === 0) return null;

  // The last event at or before `minute`, else yesterday's last one.
  let i = events.length - 1;
  for (let j = 0; j < events.length && events[j].time <= minute; j++) i = j;

  const prev = events[i];
  const next = events[(i + 1) % events.length];
  const span = (next.time - prev.time + 1440) % 1440 || 1440;
  const t = ((minute - prev.time + 1440) % 1440) / span;

  const lerp = (name: keyof ChannelValues) => prev.value[name] + (next.value[name] - prev.value[name]) * t;
  return {
    red: lerp('red'), green: lerp('green'), blue: lerp('blue'), white: lerp('white'),
  };
}

export class JuwelCloud {

  readonly host: string;
  private readonly email: string;
  private readonly password: string;
  private token: string | null = null;

  constructor(options: JuwelCloudOptions) {
    if (!options.email || !options.password) {
      throw new Error('email and password are required');
    }
    this.email = options.email;
    this.password = options.password;
    this.host = options.host ?? API_HOST;
  }

  get isLoggedIn(): boolean {
    return this.token !== null;
  }

  /**
   * fetch() with the client timeout. Timeouts and network failures become a
   * JuwelApiError so callers can treat all transient trouble the same way.
   */
  private async send(method: HttpMethod, path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.host}${path}`, {
        ...init, method, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError'
        ? `timed out after ${TIMEOUT_MS / 1000}s`
        : `failed: ${err instanceof Error ? err.message : String(err)}`;
      throw new JuwelApiError(`${method} ${path} ${reason}`);
    }
  }

  /** Log in and store the bearer token. Throws JuwelAuthError on bad credentials. */
  async login(): Promise<void> {
    const res = await this.send('POST', '/auth/login', {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        email: this.email,
        password: this.password,
        environmentName: ENVIRONMENT_NAME,
      }),
    });

    const text = await res.text();
    if (res.status === 200 || res.status === 201) {
      const data = JSON.parse(text) as LoginResponse;
      this.token = data.accountToken ?? data.accessToken ?? null;
      if (!this.token) throw new JuwelApiError('Login response contained no token');
      return;
    }
    if (res.status === 401) throw new JuwelAuthError('Email or password is wrong');
    throw new JuwelApiError(`Login HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  private async request<T>(method: HttpMethod, path: string, body?: unknown, retry = true): Promise<T> {
    if (!this.token) await this.login();

    const res = await this.send(method, path, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && retry) {
      this.token = null;
      return this.request<T>(method, path, body, false);
    }

    const text = await res.text();
    if (![200, 201, 202, 204].includes(res.status)) {
      throw new JuwelApiError(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204 || !text) return null as T;
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('application/json') ? JSON.parse(text) : text) as T;
  }

  // ---- read ---------------------------------------------------------

  /** Account settings, including the list of devices. */
  getSettings(): Promise<Settings> {
    return this.request<Settings>('GET', '/settings');
  }

  /** All lighting profiles including their daily curve (timeEvents). */
  getPresets(): Promise<Preset[]> {
    return this.request<Preset[]>('GET', '/presets');
  }

  /** Feeding plans for SmartFeed devices. */
  getFeederPresets(): Promise<FeederPreset[]> {
    return this.request<FeederPreset[]>('GET', '/presets/feeder');
  }

  /** Create or overwrite one feeding plan. The cloud answers 204 with no body. */
  saveFeederPreset(preset: FeederPreset): Promise<null> {
    return this.request<null>('POST', '/presets/feeder', preset);
  }

  /** Capability description (traits) of a product, e.g. "@juwel.lighting.helialux1". */
  getProductConfig(productId: string): Promise<ProductConfig> {
    return this.request<ProductConfig>('GET', `/config/product/${encodeURIComponent(productId)}`);
  }

  /** Current state of one device. */
  getState(cloudDeviceId: string): Promise<DeviceState> {
    return this.request<DeviceState>('GET', `/device/${encodeURIComponent(cloudDeviceId)}/state`);
  }

  // ---- write --------------------------------------------------------

  /** Set one or more state fields: { msg_key: value, ... } */
  setState(cloudDeviceId: string, fields: StatePayload): Promise<unknown> {
    return this.request<unknown>('POST', `/device/${encodeURIComponent(cloudDeviceId)}/state`, {
      payload: { type: 'request', ...fields },
    });
  }

  command(cloudDeviceId: string, body: CommandBody): Promise<unknown> {
    return this.request<unknown>('POST', `/device/${encodeURIComponent(cloudDeviceId)}/command`, body);
  }

  /** Pause the schedule (manual / preview mode) for `timeout` seconds. */
  pauseSchedule(cloudDeviceId: string, timeout = 3600): Promise<unknown> {
    return this.command(cloudDeviceId, { type: 'preset', action: 'pause', timeout });
  }

  /** Resume the automatic schedule. */
  resumeSchedule(cloudDeviceId: string): Promise<unknown> {
    return this.command(cloudDeviceId, { type: 'preset', action: 'resume' });
  }

  // ---- light convenience -------------------------------------------

  /**
   * Set manual light values, all in percent (0..100). While the schedule
   * runs (mode "auto") the lamp ignores manual writes, so the schedule is
   * paused first (preview mode, default 1 h), exactly as the app does.
   *
   * Pass `current` if you already have a fresh state to save a round trip;
   * otherwise it is fetched. The state is also used to complete a partial
   * red/green/blue update, since the cloud writes those three as one object.
   * When the mode is unknown (e.g. the cloud reports the device offline and
   * returns no trait values) the schedule is paused anyway: pausing twice is
   * harmless, a swallowed manual command is not.
   */
  async setManual(cloudDeviceId: string, options: ManualLightOptions, current?: DeviceState): Promise<void> {
    const state = current ?? (await this.getState(cloudDeviceId));
    if (state.mode === undefined || state.mode === 'auto') await this.pauseSchedule(cloudDeviceId);

    const fields: StatePayload = {};
    if (options.status !== undefined) fields.status = options.status;
    if (options.brightness !== undefined) {
      fields.brightness = { percentage: Math.round(clamp(options.brightness, 0, 100)) };
    }

    const ch = options.channels ?? {};
    if (ch.red !== undefined || ch.green !== undefined || ch.blue !== undefined) {
      const now = channelLevels(state);
      const pick = (name: 'red' | 'green' | 'blue'): number => {
        const v = ch[name] ?? now[name];
        if (v === undefined) {
          throw new JuwelApiError(`channels.${name} not given and device state has no colour to fall back on`);
        }
        return v;
      };
      fields.color = { red: pctToByte(pick('red')), green: pctToByte(pick('green')), blue: pctToByte(pick('blue')) };
    }
    if (ch.white !== undefined) fields.white = { value: pctToByte(ch.white) };

    if (Object.keys(fields).length > 0) await this.setState(cloudDeviceId, fields);
  }

  /** Turn the light on, optionally with brightness / channels in percent. Pauses the schedule if needed. */
  turnOn(cloudDeviceId: string, options: Omit<ManualLightOptions, 'status'> = {}): Promise<void> {
    return this.setManual(cloudDeviceId, { ...options, status: 'on' });
  }

  /** Turn the light off. Pauses the schedule if needed. */
  turnOff(cloudDeviceId: string): Promise<void> {
    return this.setManual(cloudDeviceId, { status: 'off' });
  }

  /** Assign profile `slot` to a weekday (0 = Sunday .. 6 = Saturday). */
  setPresetForWeekday(cloudDeviceId: string, slot: number | string, dayOfWeek: number): Promise<unknown> {
    return this.command(cloudDeviceId, {
      type: 'preset', action: 'set', id: slot, dayOfWeek,
    });
  }

}
