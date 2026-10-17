import Homey from 'homey';

import { config } from '../../lib/config';
import { mapWorkMode } from '../../lib/marstek-ble';
import MarstekVenusBleDriver, { PollResult } from './driver';

// Capabilities managed by this device (added on init if missing, to support upgrades).
const CAPABILITIES: string[] = [
    'battery_charging_state',
    'measure_battery',
    'measure_battery_soh',
    'battery_work_mode',
    'measure_power',
    'measure_power_ongrid',
    'measure_power_offgrid',
    'measure_voltage',
    'measure_current',
    'measure_temperature',
    'measure_temperature.mosfet',
    'meter_power.charge',
    'meter_power.discharge',
    'meter_power.daily_charge',
    'meter_power.daily_discharge',
    'alarm_generic',
    'battery_alarm_code',
    'last_message_received',
];

/**
 * Represents a Marstek Venus battery connected over Bluetooth Low Energy.
 * Periodically connects, reads telemetry and maps it to Homey capabilities.
 * @extends Homey.Device
 */
export default class MarstekVenusBleDevice extends Homey.Device {

    // Cast pointer to our driver
    private myDriver: MarstekVenusBleDriver = this.driver as MarstekVenusBleDriver;

    // Interval that triggers BLE poll cycles.
    private pollTimeout?: NodeJS.Timeout = undefined;

    // Interval that keeps the "data age" capability up to date.
    private ageTimeout?: NodeJS.Timeout = undefined;

    // True while a poll cycle is running, to avoid overlapping cycles.
    private polling: boolean = false;

    // Timestamp of the last successful read.
    private timestamp?: Date = undefined;

    // Trigger card fired when the BMS error/warning code changes.
    private alarmChangedTrigger?: Homey.FlowCardTriggerDevice = undefined;

    /**
     * Called by Homey when the device is initialised.
     * Ensures capabilities exist and starts background polling when enabled.
     * @returns {Promise<void>} Resolves once startup completes.
     */
    async onInit() {
        if (this.debug) this.log('MarstekVenusBleDevice has been initialized');

        for (const cap of CAPABILITIES) {
            if (!this.hasCapability(cap)) await this.addCapability(cap);
        }

        this.alarmChangedTrigger = this.homey.flow.getDeviceTriggerCard('marstek_ble_alarm_changed');

        if (this.getSetting('poll') !== false) this.startPolling();
    }

    /**
     * Starts the poll interval and the data-age updater.
     */
    startPolling() {
        this.stopPolling();
        const seconds = Math.max(30, Number(this.getSetting('interval')) || 60);
        if (this.debug) this.log('Start BLE polling every', seconds, 'seconds');

        this.pollTimeout = this.homey.setInterval(() => {
            this.poll().catch((err) => this.error('Poll cycle error:', err));
        }, seconds * 1000);

        // Kick off an immediate first poll.
        this.poll().catch((err) => this.error('Initial poll error:', err));

        this.ageTimeout = this.homey.setInterval(async () => {
            if (this.timestamp) {
                const diff = Math.round((Date.now() - this.timestamp.getTime()) / 1000);
                await this.setCapabilityValue('last_message_received', diff).catch(() => {});
            }
        }, 5000);
    }

    /**
     * Stops the poll interval and the data-age updater.
     */
    stopPolling() {
        if (this.pollTimeout) {
            this.homey.clearInterval(this.pollTimeout);
            this.pollTimeout = undefined;
        }
        if (this.ageTimeout) {
            this.homey.clearInterval(this.ageTimeout);
            this.ageTimeout = undefined;
        }
    }

    /**
     * Runs a single BLE poll cycle and maps the telemetry to capabilities.
     * @returns {Promise<void>} Resolves once the cycle completes.
     */
    async poll() {
        if (this.polling) {
            if (this.debug) this.log('Skipping poll: previous cycle still running');
            return;
        }
        this.polling = true;
        try {
            const uuid = this.myDriver.getPeripheralUuid(this);
            const result = await this.myDriver.readAll(uuid);
            await this.applyResult(result);

            if (result.runtime || result.bms) {
                this.timestamp = new Date();
                await this.setCapabilityValue('last_message_received', 0).catch(() => {});
                if (!this.getAvailable()) await this.setAvailable();
            } else {
                await this.setUnavailable('Connected over Bluetooth but the battery returned no data.').catch(() => {});
            }
        } catch (err) {
            // Surface the reason in the Homey UI (truncated) instead of only logging it.
            const message = (err as Error).message || 'Bluetooth communication failed';
            this.error('Poll failed:', message);
            await this.setUnavailable(`Bluetooth: ${message}`.slice(0, 200)).catch(() => {});
        } finally {
            this.polling = false;
        }
    }

    /**
     * Maps a poll result onto the device capabilities. Values are only written when present.
     * @param {PollResult} result Parsed telemetry from a poll cycle.
     * @returns {Promise<void>} Resolves once all values are written.
     */
    async applyResult(result: PollResult): Promise<void> {
        const { runtime, bms, deviceInfo } = result;

        // Log the full parsed (already converted) telemetry for diagnostics.
        if (this.debug) {
            if (runtime) this.log('Parsed Runtime Info:', JSON.stringify(runtime));
            if (bms) this.log('Parsed BMS Data:', JSON.stringify(bms));
            if (deviceInfo) this.log('Parsed Device Info:', JSON.stringify(deviceInfo));
        }

        if (runtime) {
            // Runtime offset 0x02 is the AC grid-port power (verified identical to the Local
            // API's ongrid_power); both drivers invert its sign for the On-Grid capability.
            await this.setValue('measure_power_ongrid', -runtime.ongridPower);
            // Runtime offset 0x00 is the backup/EPS (off-grid) port power; same sign treatment
            // as the Local API driver's factor of -1.
            await this.setValue('measure_power_offgrid', -runtime.offgridPower);
            await this.setValue('meter_power.charge', runtime.totalCharge);
            await this.setValue('meter_power.discharge', runtime.totalDischarge);
            await this.setValue('meter_power.daily_charge', runtime.dailyCharge);
            await this.setValue('meter_power.daily_discharge', runtime.dailyDischarge);
            await this.setValue('battery_work_mode', mapWorkMode(runtime.workMode));

            // Reflect device state in the read-only settings labels (only when changed).
            const labels: Record<string, string> = {};
            if (runtime.powerRating !== undefined) labels.power_rating = `${runtime.powerRating} W`;
            if (runtime.localApiEnabled !== undefined) {
                labels.local_api = runtime.localApiEnabled ? `Enabled (port ${runtime.apiPort})` : 'Disabled';
            }
            const changed = Object.entries(labels).filter(([key, value]) => this.getSetting(key) !== value);
            if (changed.length > 0) await this.setSettings(Object.fromEntries(changed)).catch(() => {});
        }

        if (bms) {
            await this.setValue('measure_battery', bms.soc);
            await this.setValue('measure_battery_soh', bms.soh);
            await this.setValue('measure_voltage', bms.voltage);
            await this.setValue('measure_current', bms.current);
            await this.setValue('measure_temperature', bms.batteryTemperature);
            await this.setValue('measure_temperature.mosfet', bms.mosfetTemperature);

            // True DC battery power: BMS pack voltage x current. This matches the Local API's
            // bat_power (the Runtime frame only carries the AC-port measurement).
            const batteryPower = Math.round(bms.voltage * bms.current);
            await this.setValue('measure_power', batteryPower);
            let chargingState = 'idle';
            if (batteryPower > 0) chargingState = 'charging';
            if (batteryPower < 0) chargingState = 'discharging';
            await this.setValue('battery_charging_state', chargingState);
            const alarmActive = (bms.errorCode !== 0) || (bms.warningCode !== 0);
            await this.setValue('alarm_generic', alarmActive);

            // Expose the raw BMS codes; their bit meanings are not (yet) documented, so show
            // them verbatim and fire the trigger whenever they change (including clearing).
            const errorHex = `0x${bms.errorCode.toString(16).padStart(4, '0').toUpperCase()}`;
            const warningHex = `0x${bms.warningCode.toString(16).padStart(8, '0').toUpperCase()}`;
            const codeText = alarmActive ? `Error ${errorHex} / Warning ${warningHex}` : 'OK';
            const previousCodeText = this.getCapabilityValue('battery_alarm_code');
            await this.setValue('battery_alarm_code', codeText);
            if (previousCodeText !== null && previousCodeText !== codeText) {
                await this.alarmChangedTrigger
                    ?.trigger(this, { error_code: errorHex, warning_code: warningHex })
                    .catch((err) => this.error('Failed to trigger alarm changed:', err));
            }
            if (this.debug && alarmActive) {
                this.log('BMS fault codes — error:', bms.errorCode, 'warning:', bms.warningCode);
            }
        }

        if (deviceInfo) {
            const settings: Record<string, string> = {};
            if (deviceInfo.type) settings.model = deviceInfo.type;
            if (deviceInfo.sn) settings.serial = deviceInfo.sn;
            if (deviceInfo.mac) settings.mac = deviceInfo.mac;
            if (deviceInfo.fw) settings.firmware = deviceInfo.fw;
            if (Object.keys(settings).length > 0) await this.setSettings(settings).catch(() => {});
        }
    }

    /**
     * Sets a capability value, ignoring null/NaN and swallowing capability errors.
     * @param {string} capabilityId Capability to update.
     * @param {any} value New value.
     * @returns {Promise<void>} Resolves once the value is written.
     */
    async setValue(capabilityId: string, value: any): Promise<void> {
        if (value === null || value === undefined) return;
        if (typeof value === 'number' && Number.isNaN(value)) return;
        if (!this.hasCapability(capabilityId)) return;
        if (this.debug) this.log(`Capability ${capabilityId} = ${value}`);
        await this.setCapabilityValue(capabilityId, value).catch((err) => {
            if (this.debug) this.error(`Failed to set ${capabilityId}:`, err);
        });
    }

    /**
     * Called when device settings change. Restarts polling when poll/interval change.
     * @param {any} event Homey settings change event.
     * @returns {Promise<void>} Resolves once handled.
     */
    async onSettings(event: any): Promise<void> {
        if (event.changedKeys.includes('poll') || event.changedKeys.includes('interval')) {
            if (event.newSettings.poll !== false) {
                // Delay so the new settings are persisted before we read them back.
                this.homey.setTimeout(() => this.startPolling(), 500);
            } else {
                this.stopPolling();
            }
        }
    }

    /**
     * Called when the device is removed. Cleans up intervals.
     * @returns {Promise<void>} Resolves once cleanup finishes.
     */
    async onDeleted() {
        this.stopPolling();
        if (this.debug) this.log('MarstekVenusBleDevice has been deleted');
    }

    /**
     * Called when the device is uninitialised. Cleans up intervals.
     * @returns {Promise<void>} Resolves once cleanup finishes.
     */
    async onUninit() {
        this.stopPolling();
        if (this.debug) this.log('MarstekVenusBleDevice has been uninitialized');
    }

    /**
     * Whether debug logging is enabled (device setting or test build).
     * @returns {boolean} True when verbose logging should be emitted.
     */
    get debug(): boolean {
        return (this.getSetting('debug') === true) || config.isTestVersion;
    }

}

// Also use module.exports for Homey
module.exports = MarstekVenusBleDevice;
