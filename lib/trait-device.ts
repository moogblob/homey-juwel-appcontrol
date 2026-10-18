import Homey from 'homey';
import {
  JuwelApiError, JuwelAuthError, JuwelCloud, type DeviceState,
} from './juwel/client.js';
import { parseTraits, type Traits } from './juwel/traits.js';
import type JuwelApp from '../app.js';

const DEFAULT_POLL_INTERVAL = 30;

/** Delay before re-reading state after a write, to let the cloud catch up. */
const SETTLE_MS = 3000;

/**
 * Base for devices driven by the product catalogue (SmartFeed, EccoFlow).
 *
 * The catalogue's traits tell which state field (msg_key) holds what and
 * which values a write may use. They are loaded once, before the first state
 * is applied; until then the device keeps its last known values.
 */
export default abstract class TraitDevice extends Homey.Device {

  protected traits: Traits | null = null;
  protected state: DeviceState | null = null;

  private pollTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;

  /** Called once after the traits are known, e.g. to drop unsupported capabilities. */
  protected abstract onTraitsLoaded(traits: Traits): Promise<void>;

  /** Map a fresh device state onto the capabilities. */
  protected abstract applyState(state: DeviceState, traits: Traits): Promise<void>;

  async onInit() {
    await this.refresh();
    this.startPolling();
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

  // ---- state ----------------------------------------------------------

  protected async refresh() {
    let state: DeviceState;

    try {
      const traits = await this.getTraits();
      state = await this.getCloud().getState(this.getDeviceId());
      this.state = state;

      const reachable = state.connected !== false
        && (state.connectivity as { value?: string } | undefined)?.value !== 'UNREACHABLE';
      if (!reachable) {
        await this.setUnavailable(this.homey.__('error.device_offline'));
        return;
      }
      await this.setAvailable();
      await this.applyState(state, traits);
    } catch (err) {
      if (err instanceof JuwelAuthError) {
        await this.setUnavailable(this.homey.__('error.credentials_rejected'));
        return;
      }
      // Transient cloud or network trouble: keep the last known values and
      // let the next poll recover, rather than flapping the device offline.
      this.error('Could not read device state:', err instanceof JuwelApiError ? err.message : err);
    }
  }

  /** The traits, fetched from the catalogue on first use. */
  protected async getTraits(): Promise<Traits> {
    if (this.traits !== null) return this.traits;

    const productId = this.getStoreValue('productId') as string;
    const traits = parseTraits(await (this.homey.app as JuwelApp).getProductConfig(productId));
    await this.onTraitsLoaded(traits);
    this.traits = traits;
    return traits;
  }

  /** Write one trait value: { msg_key: value }. */
  protected async setTrait(msgKey: string, value: unknown) {
    await this.getCloud().setState(this.getDeviceId(), { [msgKey]: value });
    this.refreshAfterWrite();
  }

  /** Re-read state shortly after a write so the capabilities reflect it. */
  protected refreshAfterWrite() {
    if (this.settleTimer !== null) this.homey.clearTimeout(this.settleTimer);

    this.settleTimer = this.homey.setTimeout(() => {
      this.settleTimer = null;
      this.refresh().catch((err) => this.error('Refresh after write failed:', err));
    }, SETTLE_MS);
  }

  /** Set a capability only if the device has it and the value is known. */
  protected async update(capabilityId: string, value: unknown) {
    if (value === undefined || value === null || !this.hasCapability(capabilityId)) return;
    if (this.getCapabilityValue(capabilityId) === value) return;
    await this.setCapabilityValue(capabilityId, value);
  }

  /** Remove capabilities the product turns out not to support. */
  protected async removeCapabilities(...capabilityIds: string[]) {
    for (const id of capabilityIds) {
      if (this.hasCapability(id)) await this.removeCapability(id);
    }
  }

  // ---- plumbing --------------------------------------------------------

  protected getCloud(): JuwelCloud {
    return (this.homey.app as JuwelApp).getCloud();
  }

  protected getDeviceId(): string {
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
