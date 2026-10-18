import type { DeviceState } from '../../lib/juwel/client.js';
import {
  T_MODE, T_POWER, T_POWER_LIMIT, T_SMART_FEED, T_SPEED_LPH, T_STATUS, T_TIMER_RESET,
  enumValues, firstTrait, onOffValues, toNumber, unwrap, type Traits,
} from '../../lib/juwel/traits.js';
import TraitDevice from '../../lib/trait-device.js';

/** On/off capabilities and the traits behind them, first match wins. */
const SWITCHES: [capabilityId: string, traitIds: string[]][] = [
  ['onoff', [T_POWER, T_STATUS]],
  ['onoff.smart_feed', [T_SMART_FEED]],
  ['onoff.power_limit', [T_POWER_LIMIT]],
];

/**
 * JUWEL EccoFlow. UNTESTED: neither this app's author nor the upstream Home
 * Assistant integration had one, so everything here is derived from the
 * product catalogue alone. Following upstream, a control is only offered
 * where the catalogue defines the allowed values (an enum or a boolean);
 * anything else is shown read-only or left out, so no value the pump cannot
 * validate is ever sent.
 *
 * Not covered: the water temperature and the pump's alarms, which the
 * product page advertises but the catalogue does not describe.
 */
export default class EccoFlowDevice extends TraitDevice {

  async onInit() {
    for (const [capabilityId, traitIds] of SWITCHES) {
      this.registerCapabilityListener(capabilityId, (value: boolean) => this.setSwitch(traitIds, value));
    }

    await super.onInit();
    this.log(`EccoFlow ${this.getName()} has been initialized`);
  }

  protected async onTraitsLoaded(traits: Traits) {
    for (const [capabilityId, traitIds] of SWITCHES) {
      const trait = firstTrait(traits, ...traitIds);
      if (!trait || !onOffValues(trait)) await this.removeCapabilities(capabilityId);
    }
    if (!traits.has(T_MODE)) await this.removeCapabilities('juwel_pump_mode');
    if (!traits.has(T_SPEED_LPH)) await this.removeCapabilities('juwel_flow_rate');

    this.log('EccoFlow traits:', [...traits.values()].map((t) => `${t.trait} -> ${t.msg_key}`).join(', '));
  }

  protected async applyState(state: DeviceState, traits: Traits) {
    for (const [capabilityId, traitIds] of SWITCHES) {
      const trait = firstTrait(traits, ...traitIds);
      const values = trait && onOffValues(trait);
      if (trait && values && trait.msg_key in state) {
        await this.update(capabilityId, unwrap(state[trait.msg_key]) === values[0]);
      }
    }

    const mode = traits.get(T_MODE);
    if (mode) {
      const value = unwrap(state[mode.msg_key]);
      if (value !== undefined && value !== null) await this.update('juwel_pump_mode', String(value));
    }

    const flow = traits.get(T_SPEED_LPH);
    if (flow) await this.update('juwel_flow_rate', toNumber(state[flow.msg_key]));
  }

  // ---- writes ---------------------------------------------------------

  private async setSwitch(traitIds: string[], on: boolean) {
    const trait = firstTrait(await this.getTraits(), ...traitIds);
    const values = trait && onOffValues(trait);
    if (!trait || !values) throw new Error(this.homey.__('error.not_supported'));

    await this.setTrait(trait.msg_key, on ? values[0] : values[1]);
  }

  /** Operating modes the catalogue allows, for the flow card's autocomplete. */
  async getModes(): Promise<(string | number)[]> {
    const trait = (await this.getTraits()).get(T_MODE);
    return trait ? enumValues(trait) : [];
  }

  async setMode(mode: string | number) {
    const trait = (await this.getTraits()).get(T_MODE);
    if (!trait || !enumValues(trait).includes(mode)) throw new Error(this.homey.__('error.not_supported'));

    await this.setTrait(trait.msg_key, mode);
  }

  /** Maintenance timers the catalogue lists, e.g. clean_pump, impeller, all. */
  async getTimers(): Promise<(string | number)[]> {
    const trait = (await this.getTraits()).get(T_TIMER_RESET);
    return trait ? enumValues(trait) : [];
  }

  async resetTimer(timer: string | number) {
    const trait = (await this.getTraits()).get(T_TIMER_RESET);
    if (!trait || !enumValues(trait).includes(timer)) throw new Error(this.homey.__('error.not_supported'));

    // Sent the way the catalogue declares it: wrapped when the enum sits on a property.
    const property = Object.keys(trait.value_schema?.properties ?? {})[0];
    await this.setTrait(trait.msg_key, property ? { [property]: timer } : timer);
  }

}
