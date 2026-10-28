import Homey from 'homey';
import { pctToByte, type ChannelValues, type HeliaLuxState } from '../../lib/juwel/client.js';
import { JuwelLocalError, type JuwelLocal } from '../../lib/juwel/local.js';
import type JuwelApp from '../../app.js';
import { hsToRgbPercent, rgbPercentToHs } from '../../lib/color.js';

const DEFAULT_POLL_INTERVAL = 30;

/**
 * How long a manual override holds the schedule before the lamp resumes it by
 * itself. Matches the MyJUWEL app's own preview window.
 */
const PREVIEW_TIMEOUT_S = 3600;

/**
 * Store key holding when the lamp was switched off from Schedule mode (epoch
 * ms). Switching off pauses the schedule, so while that pause lasts,
 * switching on resumes the schedule instead of staying in Manual mode.
 */
const STORE_OFF_FROM_SCHEDULE_AT = 'offFromScheduleAt';

/** Store key holding the manual light (a `Light`) the lamp had when Homey switched it off. */
const STORE_LAST_LIGHT = 'lastLight';

/** Failed polls in a row before the lamp is shown as unavailable. */
const OFFLINE_AFTER_FAILURES = 2;

/**
 * Right after a resume the lamp still reports the manual light; the
 * schedule's light shows in its status about a second later.
 */
const RESUME_SETTLE_MS = 1500;

/** Colour changes arrive one capability at a time; coalesce them into one call. */
const COLOR_DEBOUNCE_MS = 500;

/** A lamp's status as it answers `{"type":"request"}`. */
type LocalStatus = HeliaLuxState & { error?: string[] };

/**
 * A light in Homey's terms, all in percent (0..100): `brightness` (`dim`)
 * over channels whose strongest one is at 100.
 */
type Light = { brightness: number; channels: ChannelValues };

const FULL_WHITE: ChannelValues = {
  red: 100, green: 100, blue: 100, white: 100,
};

function toPercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

function toUnit(percent: number): number {
  return Math.min(1, Math.max(0, percent / 100));
}

/** All four channel levels of a status in percent, unrounded, or null when it lacks any. */
function channelsOf(state: HeliaLuxState): ChannelValues | null {
  if (state.color === undefined || state.white === undefined) return null;
  const pct = (byte: number) => (Math.min(255, Math.max(0, byte)) / 255) * 100;
  return {
    red: pct(state.color.red), green: pct(state.color.green), blue: pct(state.color.blue), white: pct(state.white.value),
  };
}

/**
 * Channel levels as a Light: the strongest channel becomes the brightness
 * and the channels are scaled up to match, so brightness × channel gives the
 * same light. This keeps `dim` telling how bright the lamp is, e.g. 5% for a
 * faint blue night light. Null when every channel is 0.
 */
function asLight(levels: ChannelValues): Light | null {
  const max = Math.max(levels.red, levels.green, levels.blue, levels.white);
  if (max <= 0) return null;

  const scale = (v: number) => Math.min(100, (v / max) * 100);
  return {
    brightness: max,
    channels: {
      red: scale(levels.red), green: scale(levels.green), blue: scale(levels.blue), white: scale(levels.white),
    },
  };
}

export default class HeliaLuxDevice extends Homey.Device {

  private pollTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;

  /** Writes in progress. A poll meanwhile would show a half-done change, so it is skipped. */
  private pendingWrites = 0;

  /** Polls in a row that got no answer from the lamp. */
  private failedPolls = 0;

  private readonly onLocalMessage = (unitId: string, message: LocalStatus) => {
    if (unitId !== this.getUnitId() || message.type !== 'status' || this.pendingWrites > 0) return;
    this.applyStatus(message).catch((err) => this.error('Could not apply a status update:', err));
  };

  async onInit() {
    const aesKey = this.getStoreValue('aesKey');
    if (typeof aesKey !== 'string' || aesKey === '') {
      await this.setUnavailable(this.homey.__('error.repair_needed'));
      return;
    }
    this.getLocal().addLamp(this.getUnitId(), aesKey);
    this.getLocal().on('message', this.onLocalMessage);

    this.registerCapabilityListener('onoff', (value: boolean) => this.writing(() => this.setPower(value)));
    this.registerCapabilityListener('dim', (value: number) => this.writing(() => this.setBrightness(value)));
    this.registerCapabilityListener('dim.white', (value: number) => this.writing(() => this.setWhite(value)));
    this.registerCapabilityListener('helialux_mode', (value: string) => this.writing(() => this.setMode(value)));
    this.registerMultipleCapabilityListener(
      ['light_hue', 'light_saturation'],
      (values: { light_hue?: number; light_saturation?: number }) => this.writing(() => this.setColor(values)),
      COLOR_DEBOUNCE_MS,
    );

    // Not awaited: finding a lamp that is off or unplugged takes up to 10 s,
    // which would hold up the app's start.
    this.refresh().catch((err) => this.error('First refresh failed:', err));
    this.startPolling();

    this.log(`"${this.getName()}" has been initialized`);
  }

  async onSettings({ changedKeys }: { changedKeys: string[] }) {
    if (changedKeys.includes('poll_interval')) this.startPolling();
  }

  async onUninit() {
    this.stopTimers();
    this.getLocal().off('message', this.onLocalMessage);
  }

  onDeleted() {
    this.stopTimers();
    this.getLocal().off('message', this.onLocalMessage);
    this.getLocal().removeLamp(this.getUnitId());
  }

  // ---- capability listeners ------------------------------------------

  private async writing(write: () => Promise<void>) {
    this.pendingWrites += 1;
    try {
      await write();
    } finally {
      this.pendingWrites -= 1;
    }
  }

  private async setPower(on: boolean) {
    if (on && this.switchedOffFromSchedule()) {
      await this.forgetOffFromSchedule();
      await this.resumeSchedule();
    } else if (on) {
      await this.setManual({});
    } else {
      await this.switchOff();
    }
  }

  private async setBrightness(value: number) {
    await this.forgetOffFromSchedule();
    const percentage = toPercent(value);
    if (percentage === 0) await this.switchOff();
    else await this.setManual({ brightness: percentage });
  }

  private async setWhite(value: number) {
    await this.forgetOffFromSchedule();
    await this.setManual({ channels: { white: toPercent(value) } });
  }

  /**
   * Hue and saturation are converted at full value: the lamp's master dimmer
   * is exposed separately as `dim`, so folding the dim level in here would
   * darken the light twice.
   */
  private async setColor(values: { light_hue?: number; light_saturation?: number }) {
    const hue = values.light_hue ?? (this.getCapabilityValue('light_hue') as number | null) ?? 0;
    const saturation = values.light_saturation
      ?? (this.getCapabilityValue('light_saturation') as number | null)
      ?? 0;

    await this.forgetOffFromSchedule();
    await this.setManual({ channels: hsToRgbPercent({ hue, saturation }) });
  }

  private async setMode(mode: string) {
    await this.forgetOffFromSchedule();
    if (mode === 'auto') {
      await this.resumeSchedule();
    } else {
      await this.pause();
      await this.refresh(true);
    }
  }

  /** Whether the lamp was switched off from Schedule mode and that pause still holds. */
  private switchedOffFromSchedule(): boolean {
    const at = this.getStoreValue(STORE_OFF_FROM_SCHEDULE_AT);
    return typeof at === 'number' && Date.now() - at < PREVIEW_TIMEOUT_S * 1000;
  }

  /** Any other change from Homey means the user wants Manual mode after all. */
  private async forgetOffFromSchedule() {
    if (typeof this.getStoreValue(STORE_OFF_FROM_SCHEDULE_AT) === 'number') {
      await this.unsetStoreValue(STORE_OFF_FROM_SCHEDULE_AT);
    }
  }

  // ---- lamp requests ---------------------------------------------------
  //
  // Like the MyJUWEL app, the lamp's master brightness stays at 100 and
  // Homey's brightness scales the four channels instead. In webcam tests a
  // change of the master brightness made the lamp ignore or mix up later
  // writes, and at 0 it stays dark until the schedule runs again. Off is all
  // channels at 0, so the manual on/off flag stays "on". The lamp refuses
  // manual writes while the schedule runs, so that is paused first (preview
  // mode, 1 h), as the app does.

  /** Switch to manual light with `change` applied to the light the lamp shows now. */
  private async setManual(change: { brightness?: number; channels?: Partial<ChannelValues> }) {
    const state = await this.readStatus();
    const current = this.currentLight(state);

    if (state.mode === 'rgb' && state.brightness?.percentage === 0) {
      // Left at master brightness 0 by another app: only the schedule lights it again.
      await this.request({ type: 'preset', action: 'resume' });
      await this.pause();
    } else if (state.mode !== 'rgb') {
      await this.pause();
    }

    await this.sendLight({
      brightness: change.brightness ?? current.brightness,
      channels: { ...current.channels, ...change.channels },
    });
  }

  /** Switch off, remembering the light so that "on" brings it back. */
  private async switchOff() {
    const state = await this.readStatus();
    const lit = this.litLight(state);
    if (lit !== null) await this.setStoreValue(STORE_LAST_LIGHT, lit);

    if (state.mode !== 'rgb') await this.pause();
    await this.sendLight({ brightness: 0, channels: FULL_WHITE });
    if (state.mode === 'auto') await this.setStoreValue(STORE_OFF_FROM_SCHEDULE_AT, Date.now());
  }

  /** Resume the schedule; its light replaces the manual one at once. */
  private async resumeSchedule() {
    await this.request({ type: 'preset', action: 'resume' });
    await this.refresh(true);

    if (this.settleTimer !== null) this.homey.clearTimeout(this.settleTimer);
    this.settleTimer = this.homey.setTimeout(() => {
      this.settleTimer = null;
      this.refresh().catch((err) => this.error('Refresh after resume failed:', err));
    }, RESUME_SETTLE_MS);
  }

  private async pause() {
    await this.request({ type: 'preset', action: 'pause', timeout: PREVIEW_TIMEOUT_S });
  }

  /** Send a whole manual light: the channels scaled by its brightness, at master brightness 100. */
  private async sendLight(light: Light) {
    const brightness = Math.min(100, Math.max(0, light.brightness));
    const level = (pct: number) => pctToByte((pct * brightness) / 100);
    await this.applyStatus(await this.request({
      type: 'request',
      status: 'on',
      brightness: { percentage: 100 },
      color: { red: level(light.channels.red), green: level(light.channels.green), blue: level(light.channels.blue) },
      white: { value: level(light.channels.white) },
    }));
  }

  /**
   * The light the lamp shows in `state`, or null when it is dark. The
   * schedule ignores the master brightness and the manual on/off flag; in
   * manual both apply on top of the channels.
   */
  private litLight(state: LocalStatus): Light | null {
    const channels = channelsOf(state);
    const light = channels === null ? null : asLight(channels);
    if (light === null) return null;
    if (state.mode === 'auto') return light;

    const master = state.brightness?.percentage ?? 100;
    if (state.status === 'off' || master <= 0) return null;
    return { brightness: (light.brightness * master) / 100, channels: light.channels };
  }

  /**
   * The light a manual change starts from: what the lamp shows, so a change
   * made while the schedule runs does not jump away from it; when dark, the
   * light it had when Homey switched it off, or full white.
   */
  private currentLight(state: LocalStatus): Light {
    const stored = this.getStoreValue(STORE_LAST_LIGHT) as Light | null;
    const fallback = stored && typeof stored.brightness === 'number' && stored.channels
      ? stored
      : { brightness: 100, channels: FULL_WHITE };
    return this.litLight(state) ?? fallback;
  }

  /** The lamp's status right now, also shown in Homey. */
  private async readStatus(): Promise<LocalStatus> {
    const state = await this.request({ type: 'request' });
    await this.applyStatus(state);
    return state;
  }

  private request(message: object): Promise<LocalStatus> {
    return this.getLocal().request(this.getUnitId(), message) as Promise<LocalStatus>;
  }

  // ---- state ----------------------------------------------------------

  /** Read the lamp's status. `force` reads it during a write, which a poll skips. */
  private async refresh(force = false) {
    if (this.pendingWrites > 0 && !force) return;
    let status: LocalStatus;

    try {
      status = await this.request({ type: 'request' });
    } catch (err) {
      // A missed poll or two is not worth flapping the device offline for.
      this.failedPolls += 1;
      this.error('Could not read the lamp status:', err instanceof JuwelLocalError ? err.message : err);
      if (this.failedPolls >= OFFLINE_AFTER_FAILURES) {
        await this.setUnavailable(this.homey.__('error.device_offline'));
      }
      return;
    }

    this.failedPolls = 0;
    await this.applyStatus(status);
  }

  private async applyStatus(state: LocalStatus) {
    if (state.type !== 'status') return;
    await this.setAvailable();

    if (state.mode !== undefined) {
      await this.setCapabilityValue('helialux_mode', state.mode);
    }

    // When dark, the levels stay where they were, ready for "on".
    const light = this.litLight(state);
    await this.setCapabilityValue('onoff', light !== null);
    if (light !== null) await this.showLight(light);
  }

  private async showLight(light: Light) {
    await this.setCapabilityValue('dim', toUnit(Math.round(light.brightness)));
    await this.setCapabilityValue('dim.white', toUnit(light.channels.white));

    const { red, green, blue } = light.channels;
    const hs = rgbPercentToHs({ red, green, blue });
    // Black carries no hue; keep the wheel where the user left it.
    if (hs !== null) {
      await this.setCapabilityValue('light_hue', hs.hue);
      await this.setCapabilityValue('light_saturation', hs.saturation);
    }
  }

  // ---- plumbing --------------------------------------------------------

  private getLocal(): JuwelLocal {
    return (this.homey.app as JuwelApp).getLocal();
  }

  /** The lamp's unit id (its MAC address), as paired. */
  private getUnitId(): string {
    return this.getData().id as string;
  }

  private startPolling() {
    if (this.pollTimer !== null) this.homey.clearInterval(this.pollTimer);

    const configured = Number(this.getSetting('poll_interval'));
    const seconds = Number.isFinite(configured) && configured >= 10 ? configured : DEFAULT_POLL_INTERVAL;

    this.pollTimer = this.homey.setInterval(() => {
      this.refresh().catch((err) => this.error('Poll failed:', err));
    }, seconds * 1000);
  }

  private stopTimers() {
    if (this.pollTimer !== null) this.homey.clearInterval(this.pollTimer);
    if (this.settleTimer !== null) this.homey.clearTimeout(this.settleTimer);
    this.pollTimer = null;
    this.settleTimer = null;
  }

}
