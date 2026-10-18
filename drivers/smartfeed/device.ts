import type { DeviceState } from '../../lib/juwel/client.js';
import {
  T_FEED, T_FEED_KEY_QUANTITY, T_FEED_QUANTITY, T_LED_SWITCH, T_POWER, T_STATUS,
  encode, firstTrait, numericProperty, onOffValues, toNumber, type Traits,
} from '../../lib/juwel/traits.js';
import TraitDevice from '../../lib/trait-device.js';

/** Feed amounts the SmartFeed accepts when the catalogue gives no range. */
const DEFAULT_MIN_AMOUNT = 1;
const DEFAULT_MAX_AMOUNT = 8;

/**
 * JUWEL SmartFeed. Behaviour follows the upstream Home Assistant integration,
 * where it was verified on hardware (firmware V2.0.1.58); this app's author
 * has no SmartFeed to test with.
 *
 * Besides its traits the feeder reports a few undeclared state fields:
 * - feed_chamber_status: 0 = empty, 1 = enough
 * - error: the device's own error channel, set while a command is rejected
 * - last_feed_ts: unix seconds of the last feeding, 0 = never
 */
export default class SmartFeedDevice extends TraitDevice {

  private lastFeedTs: number | null = null;

  async onInit() {
    this.registerCapabilityListener('onoff', (value: boolean) => this.setSwitch([T_STATUS, T_POWER], value));
    this.registerCapabilityListener('onoff.led', (value: boolean) => this.setSwitch([T_LED_SWITCH], value));
    this.registerCapabilityListener('juwel_feed', () => this.feed());
    this.registerCapabilityListener('juwel_feed_quantity', (value: number) => this.setQuantity(T_FEED_QUANTITY, value));
    this.registerCapabilityListener('juwel_feed_key_quantity', (value: number) => this.setQuantity(T_FEED_KEY_QUANTITY, value));

    await super.onInit();
    this.log(`SmartFeed ${this.getName()} has been initialized`);
  }

  protected async onTraitsLoaded(traits: Traits) {
    const power = firstTrait(traits, T_STATUS, T_POWER);
    if (!power || !onOffValues(power)) await this.removeCapabilities('onoff');

    const led = traits.get(T_LED_SWITCH);
    if (!led || !onOffValues(led)) await this.removeCapabilities('onoff.led');

    if (!traits.has(T_FEED)) await this.removeCapabilities('juwel_feed');
    await this.applyRange('juwel_feed_quantity', T_FEED_QUANTITY, traits);
    await this.applyRange('juwel_feed_key_quantity', T_FEED_KEY_QUANTITY, traits);
  }

  /** Drop a quantity capability without a trait, or narrow it to the catalogue's range. */
  private async applyRange(capabilityId: string, traitId: string, traits: Traits) {
    const trait = traits.get(traitId);
    const range = trait && numericProperty(trait);
    if (!range) {
      await this.removeCapabilities(capabilityId);
      return;
    }
    if (!this.hasCapability(capabilityId)) return;

    const options = this.getCapabilityOptions(capabilityId) ?? {};
    if (options.min !== range.min || options.max !== range.max) {
      await this.setCapabilityOptions(capabilityId, { ...options, min: range.min, max: range.max });
    }
  }

  protected async applyState(state: DeviceState, traits: Traits) {
    const power = firstTrait(traits, T_STATUS, T_POWER);
    const powerValues = power && onOffValues(power);
    if (power && powerValues) await this.update('onoff', state[power.msg_key] === powerValues[0]);

    const led = traits.get(T_LED_SWITCH);
    const ledValues = led && onOffValues(led);
    if (led && ledValues) await this.update('onoff.led', state[led.msg_key] === ledValues[0]);

    for (const [capabilityId, traitId] of [
      ['juwel_feed_quantity', T_FEED_QUANTITY],
      ['juwel_feed_key_quantity', T_FEED_KEY_QUANTITY],
    ]) {
      const trait = traits.get(traitId);
      if (trait) await this.update(capabilityId, toNumber(state[trait.msg_key], numericProperty(trait)?.property));
    }

    // These fields only show up once they have been used, so stay quiet until then.
    if ('feed_chamber_status' in state) {
      await this.update('alarm_generic.chamber_empty', toNumber(state.feed_chamber_status) === 0);
    }
    if ('error' in state) {
      await this.update('alarm_generic.device_error', Boolean(state.error));
    }

    await this.applyLastFeed(toNumber(state.last_feed_ts));
  }

  private async applyLastFeed(ts: number | null) {
    if (ts === null || ts <= 0) return;

    await this.update('juwel_last_feed', new Date(ts * 1000).toLocaleString(this.homey.i18n.getLanguage(), {
      timeZone: this.homey.clock.getTimezone(),
      dateStyle: 'short',
      timeStyle: 'short',
    }));

    // The first state after start-up only sets the baseline; a later, newer
    // timestamp means a feeding happened (from Homey, the plan or the device's button).
    const previous = this.lastFeedTs;
    this.lastFeedTs = ts;
    if (previous !== null && ts > previous) {
      await this.homey.flow.getDeviceTriggerCard('smartfeed_fed').trigger(this)
        .catch((err) => this.error('Could not trigger the fed flow:', err));
    }
  }

  // ---- writes ---------------------------------------------------------

  private async setSwitch(traitIds: string[], on: boolean) {
    const trait = firstTrait(await this.getTraits(), ...traitIds);
    const values = trait && onOffValues(trait);
    if (!trait || !values) throw new Error(this.homey.__('error.not_supported'));

    await this.setTrait(trait.msg_key, on ? values[0] : values[1]);
  }

  private async setQuantity(traitId: string, value: number) {
    const trait = (await this.getTraits()).get(traitId);
    const range = trait && numericProperty(trait);
    if (!trait || !range) throw new Error(this.homey.__('error.not_supported'));

    const amount = Math.round(Math.min(range.max, Math.max(range.min, value)));
    await this.setTrait(trait.msg_key, encode(this.state?.[trait.msg_key], amount, range.property));
  }

  /**
   * Feed now. Without an amount the feeder's own feed quantity is used, as
   * the app's feed button does.
   */
  async feed(amount?: number) {
    const traits = await this.getTraits();
    const trait = traits.get(T_FEED);
    if (!trait) throw new Error(this.homey.__('error.not_supported'));

    const range = numericProperty(trait);
    const min = range?.min ?? DEFAULT_MIN_AMOUNT;
    const max = range?.max ?? DEFAULT_MAX_AMOUNT;

    const quantity = traits.get(T_FEED_QUANTITY);
    const configured = quantity
      ? toNumber(this.state?.[quantity.msg_key], numericProperty(quantity)?.property)
      : null;
    const wanted = amount ?? configured ?? min;
    const clamped = Math.round(Math.min(max, Math.max(min, wanted)));

    await this.setTrait(trait.msg_key, encode(this.state?.[trait.msg_key], clamped, range?.property ?? 'feed'));
  }

}
