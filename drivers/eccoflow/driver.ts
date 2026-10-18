import Homey from 'homey';
import type JuwelApp from '../../app.js';
import type EccoFlowDevice from './device.js';

type Choice = { name: string; value: string | number };
type ChoiceArgs = { device: EccoFlowDevice };

/** Timers named in upstream's translations; others are shown as the catalogue spells them. */
const KNOWN_TIMERS = ['clean_pump', 'impeller', 'all'];

/** Turn catalogue enum values into autocomplete results, filtered by what was typed. */
function toChoices(
  values: (string | number)[],
  query: string,
  label: (value: string | number) => string | undefined = () => undefined,
): Choice[] {
  const q = query.trim().toLowerCase();
  return values
    .map((value) => ({ name: label(value) ?? String(value).replace(/_/g, ' '), value }))
    .filter((choice) => choice.name.toLowerCase().includes(q));
}

export default class EccoFlowDriver extends Homey.Driver {

  /**
   * Catalogue type of the pump. "eccoflow" is what upstream names it; "pump"
   * is a guess in case the catalogue uses the generic name. Unverified.
   */
  static readonly DEVICE_TYPES = ['eccoflow', 'pump'];

  async onInit() {
    this.homey.flow.getActionCard('eccoflow_set_mode')
      .registerArgumentAutocompleteListener('mode', async (query: string, { device }: ChoiceArgs) => {
        return toChoices(await device.getModes(), query);
      })
      .registerRunListener(({ device, mode }: ChoiceArgs & { mode: Choice }) => device.setMode(mode.value));

    this.homey.flow.getActionCard('eccoflow_reset_timer')
      .registerArgumentAutocompleteListener('timer', async (query: string, { device }: ChoiceArgs) => {
        return toChoices(await device.getTimers(), query, (value) => this.timerLabel(value));
      })
      .registerRunListener(({ device, timer }: ChoiceArgs & { timer: Choice }) => device.resetTimer(timer.value));

    this.log('EccoFlow driver has been initialized');
  }

  private timerLabel(value: string | number): string | undefined {
    const key = String(value);
    return KNOWN_TIMERS.includes(key) ? this.homey.__(`eccoflow.timer.${key}`) : undefined;
  }

  /** Lists the EccoFlow pumps on the MyJUWEL account. */
  async onPairListDevices() {
    return (this.homey.app as JuwelApp).listDevicesOfType(EccoFlowDriver.DEVICE_TYPES, 'EccoFlow');
  }

}
