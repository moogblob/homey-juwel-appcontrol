import Homey from 'homey';
import {
  JuwelApiError, JuwelAuthError, JuwelCloud, channelLevels, type DeviceState,
} from '../../lib/juwel/client.js';
import type JuwelApp from '../../app.js';
import { hsToRgbPercent, rgbPercentToHs } from '../../lib/color.js';

const DEFAULT_POLL_INTERVAL = 30;

/**
 * How long a manual override holds the schedule before the lamp resumes it by
 * itself. Matches the MyJUWEL app's own preview window.
 */
const PREVIEW_TIMEOUT_S = 3600;

/** Delay before re-reading state after a write, to let the cloud catch up. */
const SETTLE_MS = 2000;

/** Colour changes arrive one capability at a time; coalesce them into one call. */
const COLOR_DEBOUNCE_MS = 500;

function toPercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

function toUnit(percent: number): number {
  return Math.min(1, Math.max(0, percent / 100));
}

export default class HeliaLuxDevice extends Homey.Device {

  private pollTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;

  async onInit() {
    this.registerCapabilityListener('onoff', (value: boolean) => this.setPower(value));
    this.registerCapabilityListener('dim', (value: number) => this.setBrightness(value));
    this.registerCapabilityListener('dim.white', (value: number) => this.setWhite(value));
    this.registerCapabilityListener('helialux_mode', (value: string) => this.setMode(value));
    this.registerMultipleCapabilityListener(
      ['light_hue', 'light_saturation'],
      (values: { light_hue?: number; light_saturation?: number }) => this.setColor(values),
      COLOR_DEBOUNCE_MS,
    );

    await this.refresh();
    this.startPolling();

    this.log(`HeliaLux ${this.getName()} has been initialized`);
  }

  async onSettings({ changedKeys }: { changedKeys: string[] }) {
    if (changedKeys.includes('poll_interval')) this.startPolling();
  }

  async onUninit() {
    this.stopTimers();
  }

  onDeleted() {
    this.stopTimers();
  }

  // ---- capability listeners ------------------------------------------

  private async setPower(on: boolean) {
    const cloud = this.getCloud();
    if (on) await cloud.turnOn(this.getDeviceId());
    else await cloud.turnOff(this.getDeviceId());
    this.refreshAfterWrite();
  }

  private async setBrightness(value: number) {
    await this.getCloud().setManual(this.getDeviceId(), { brightness: toPercent(value) });
    this.refreshAfterWrite();
  }

  private async setWhite(value: number) {
    await this.getCloud().setManual(this.getDeviceId(), { channels: { white: toPercent(value) } });
    this.refreshAfterWrite();
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

    const channels = hsToRgbPercent({ hue, saturation });
    await this.getCloud().setManual(this.getDeviceId(), { channels });
    this.refreshAfterWrite();
  }

  private async setMode(mode: string) {
    const cloud = this.getCloud();
    if (mode === 'auto') await cloud.resumeSchedule(this.getDeviceId());
    else await cloud.pauseSchedule(this.getDeviceId(), PREVIEW_TIMEOUT_S);
    this.refreshAfterWrite();
  }

  // ---- state ----------------------------------------------------------

  private async refresh() {
    let state: DeviceState;

    try {
      state = await this.getCloud().getState(this.getDeviceId());
    } catch (err) {
      if (err instanceof JuwelAuthError) {
        await this.setUnavailable(this.homey.__('error.credentials_rejected'));
        return;
      }
      // Transient cloud or network trouble: keep the last known values and
      // let the next poll recover, rather than flapping the device offline.
      // Expected cloud errors get a one-line log; anything else keeps its stack.
      this.error('Could not read device state:', err instanceof JuwelApiError ? err.message : err);
      return;
    }

    await this.applyState(state);
  }

  private async applyState(state: DeviceState) {
    const reachable = state.connected !== false && state.connectivity?.value !== 'UNREACHABLE';
    if (!reachable) {
      await this.setUnavailable(this.homey.__('error.device_offline'));
      return;
    }
    await this.setAvailable();

    if (state.status !== undefined) {
      await this.setCapabilityValue('onoff', state.status === 'on');
    }
    if (state.mode !== undefined) {
      await this.setCapabilityValue('helialux_mode', state.mode);
    }

    // While the schedule runs the lamp reports its last manual values rather
    // than the live curve, so in "auto" mode the levels below are the values a
    // manual override would restore, not what the lamp is showing right now.
    if (state.brightness?.percentage !== undefined) {
      await this.setCapabilityValue('dim', toUnit(state.brightness.percentage));
    }

    const levels = channelLevels(state);
    if (levels.white !== undefined) {
      await this.setCapabilityValue('dim.white', toUnit(levels.white));
    }
    if (levels.red !== undefined && levels.green !== undefined && levels.blue !== undefined) {
      const hs = rgbPercentToHs({ red: levels.red, green: levels.green, blue: levels.blue });
      // Black carries no hue; keep the wheel where the user left it.
      if (hs !== null) {
        await this.setCapabilityValue('light_hue', hs.hue);
        await this.setCapabilityValue('light_saturation', hs.saturation);
      }
    }
  }

  // ---- plumbing --------------------------------------------------------

  private getCloud(): JuwelCloud {
    return (this.homey.app as JuwelApp).getCloud();
  }

  private getDeviceId(): string {
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

  /** Re-read state shortly after a write so mode and levels reflect the change. */
  private refreshAfterWrite() {
    if (this.settleTimer !== null) this.homey.clearTimeout(this.settleTimer);

    this.settleTimer = this.homey.setTimeout(() => {
      this.settleTimer = null;
      this.refresh().catch((err) => this.error('Refresh after write failed:', err));
    }, SETTLE_MS);
  }

  private stopTimers() {
    if (this.pollTimer !== null) this.homey.clearInterval(this.pollTimer);
    if (this.settleTimer !== null) this.homey.clearTimeout(this.settleTimer);
    this.pollTimer = null;
    this.settleTimer = null;
  }

}
