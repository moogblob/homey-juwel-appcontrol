import Homey from 'homey';
import {
  JuwelApiError, JuwelAuthError, JuwelCloud, activePresetId, channelLevels, presetLevelsAt,
  type ChannelValues, type DeviceState, type ManualLightOptions,
} from '../../lib/juwel/client.js';
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

/**
 * Delay before re-reading state after a write, to let the cloud catch up. It
 * records a status about 1.5 s after the write that set it.
 */
const SETTLE_MS = 4000;

/** Colour changes arrive one capability at a time; coalesce them into one call. */
const COLOR_DEBOUNCE_MS = 500;

function toPercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

function toUnit(percent: number): number {
  return Math.min(1, Math.max(0, percent / 100));
}

/**
 * A schedule's channel levels in the lamp's manual terms: the strongest
 * channel becomes the master brightness and the channels are scaled up to
 * match, so brightness × channel gives the same light. This keeps `dim`
 * telling how bright the lamp is, e.g. 5% for a faint blue night light.
 * At 0 the channels carry no information and are left out.
 */
function scheduleAsManual(levels: ChannelValues): { brightness: number; channels?: ChannelValues } {
  const max = Math.max(levels.red, levels.green, levels.blue, levels.white);
  if (max <= 0) return { brightness: 0 };

  const scale = (v: number) => Math.min(100, (v / max) * 100);
  return {
    brightness: Math.round(max),
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

  /** What the schedule is producing, while mode is "auto" and it could be computed. */
  private schedule: ChannelValues | null = null;

  async onInit() {
    this.registerCapabilityListener('onoff', (value: boolean) => this.writing(() => this.setPower(value)));
    this.registerCapabilityListener('dim', (value: number) => this.writing(() => this.setBrightness(value)));
    this.registerCapabilityListener('dim.white', (value: number) => this.writing(() => this.setWhite(value)));
    this.registerCapabilityListener('helialux_mode', (value: string) => this.writing(() => this.setMode(value)));
    this.registerMultipleCapabilityListener(
      ['light_hue', 'light_saturation'],
      (values: { light_hue?: number; light_saturation?: number }) => this.writing(() => this.setColor(values)),
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

  private async writing(write: () => Promise<void>) {
    this.pendingWrites += 1;
    try {
      await write();
    } finally {
      this.pendingWrites -= 1;
    }
  }

  private async setPower(on: boolean) {
    const cloud = this.getCloud();
    if (on && this.switchedOffFromSchedule()) {
      await cloud.resumeScheduleOn(this.getDeviceId(), await this.currentScheduleLight());
      await this.forgetOffFromSchedule();
    } else if (on) {
      await cloud.turnOn(this.getDeviceId(), this.manualFromSchedule());
    } else {
      const fromSchedule = this.getCapabilityValue('helialux_mode') === 'auto';
      await cloud.turnOff(this.getDeviceId(), this.manualFromSchedule());
      if (fromSchedule) await this.setStoreValue(STORE_OFF_FROM_SCHEDULE_AT, Date.now());
    }
    this.refreshAfterWrite();
  }

  private async setBrightness(value: number) {
    await this.forgetOffFromSchedule();
    await this.getCloud().setManual(this.getDeviceId(), { ...this.manualFromSchedule(), brightness: toPercent(value) });
    this.refreshAfterWrite();
  }

  private async setWhite(value: number) {
    await this.forgetOffFromSchedule();
    const seed = this.manualFromSchedule();
    await this.getCloud().setManual(this.getDeviceId(), {
      ...seed, channels: { ...seed.channels, white: toPercent(value) },
    });
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

    await this.forgetOffFromSchedule();
    const seed = this.manualFromSchedule();
    await this.getCloud().setManual(this.getDeviceId(), {
      ...seed, channels: { ...seed.channels, ...hsToRgbPercent({ hue, saturation }) },
    });
    this.refreshAfterWrite();
  }

  private async setMode(mode: string) {
    await this.forgetOffFromSchedule();
    const cloud = this.getCloud();
    if (mode === 'auto') await cloud.resumeScheduleOn(this.getDeviceId(), await this.currentScheduleLight());
    else await cloud.pauseSchedule(this.getDeviceId(), PREVIEW_TIMEOUT_S);
    this.refreshAfterWrite();
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

  /**
   * The schedule's light right now in manual terms, also while it is paused,
   * or empty when it cannot be worked out or is dark.
   */
  private async currentScheduleLight(): Promise<ManualLightOptions> {
    const levels = await this.scheduleLevels(await this.getCloud().getState(this.getDeviceId()));
    if (levels === null) return {};
    const manual = scheduleAsManual(levels);
    return manual.channels === undefined ? {} : manual;
  }

  /**
   * A manual change made while the schedule runs should start from the light
   * the schedule is producing, not jump to the old manual values the lamp
   * restores when paused. Empty in manual mode, or when the schedule is dark.
   */
  private manualFromSchedule(): ManualLightOptions {
    if (this.schedule === null) return {};
    const manual = scheduleAsManual(this.schedule);
    return manual.channels === undefined ? {} : manual;
  }

  // ---- state ----------------------------------------------------------

  private async refresh() {
    if (this.pendingWrites > 0) return;
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

    if (state.mode !== undefined) {
      await this.setCapabilityValue('helialux_mode', state.mode);
    }

    // While the schedule runs the lamp reports its last manual values rather
    // than the live curve, and ignores the master brightness, so in "auto"
    // mode the levels come from the active profile's curve instead. The same
    // goes for on/off: a lamp last switched off by hand keeps reporting "off"
    // while the schedule lights it, so it follows the curve's level too.
    if (state.mode === 'auto') {
      const schedule = await this.scheduleLevels(state);
      this.schedule = schedule;
      // Unknown curve: keep the last shown values rather than the stale manual ones.
      if (schedule === null) return;
      const { brightness, channels } = scheduleAsManual(schedule);
      await this.setCapabilityValue('onoff', brightness > 0);
      await this.showLevels(brightness, channels ?? {});
      return;
    }

    this.schedule = null;
    if (state.status !== undefined) {
      await this.setCapabilityValue('onoff', state.status === 'on');
    }
    await this.showLevels(state.brightness?.percentage, channelLevels(state));
  }

  /** Master brightness and channel levels, all in percent (0..100). */
  private async showLevels(brightness: number | undefined, levels: Partial<ChannelValues>) {
    if (brightness !== undefined) {
      await this.setCapabilityValue('dim', toUnit(brightness));
    }

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

  /** The active profile's channel levels right now, or null when they cannot be worked out. */
  private async scheduleLevels(state: DeviceState): Promise<ChannelValues | null> {
    const presetId = activePresetId(state);
    if (presetId === null) return null;

    try {
      const preset = await (this.homey.app as JuwelApp).getPreset(presetId);
      return preset === null ? null : presetLevelsAt(preset, this.minuteOfDay());
    } catch (err) {
      this.error('Could not read the lighting profile:', err instanceof JuwelApiError ? err.message : err);
      return null;
    }
  }

  /** Minutes after midnight in Homey's time zone, which the lamp is assumed to share. */
  private minuteOfDay(): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.homey.clock.getTimezone(), hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date());
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return part('hour') * 60 + part('minute');
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
