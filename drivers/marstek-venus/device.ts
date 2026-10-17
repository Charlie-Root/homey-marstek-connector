import Homey from 'homey';
import dgram from 'dgram'; // For UDP binding and sending
import MarstekVenusLocalApiDriver from './driver';

// Import our loaded config
import { config } from '../../lib/config';

type CapabilitySetting = {
    capabilityId: string;
    settingId: string | null;
}

const capabilities: Array<CapabilitySetting> = [
    { capabilityId: 'battery_charging_state', settingId: null },                                    // Charge state (Possible values: "idle", "charging", "discharging")
    { capabilityId: 'meter_power', settingId: 'factor_bat_capacity' },                              // Power remaining (In kWh)
    { capabilityId: 'measure_power', settingId: 'factor_bat_power' },                               // Power usage/delivery (In Watts)
    { capabilityId: 'measure_temperature', settingId: 'factor_bat_temp' },                          // Main battery temperature (In degrees celcius)
    { capabilityId: 'measure_battery', settingId: 'factor_bat_soc' },                               // State of Charge in %
    { capabilityId: 'meter_power.imported', settingId: 'factor_total_grid_input_energy' },          // Total power imported (in kWh)
    { capabilityId: 'meter_power.exported', settingId: 'factor_total_grid_output_energy' },         // Total power exported (in kWh)
    { capabilityId: 'meter_power.load', settingId: 'factor_total_load_energy' },                    // Total power consumend off grid (in kWh)
    { capabilityId: 'measure_power_ongrid', settingId: 'factor_ongrid_power' },                     // Current power usage of on-grid port (in W)
    { capabilityId: 'measure_power_offgrid', settingId: 'factor_offgrid_power' },                   // Current power usage of off-grid port (in W)
    { capabilityId: 'measure_power_pv', settingId: 'factor_pv_power' },                             // Current power usage of off-grid port (in W)
    { capabilityId: 'last_message_received', settingId: null },                                     // number of seconds the last received message
    { capabilityId: 'battery_mode', settingId: null },                                              // Battery mode (Possible values: "ai", "auto", "force_charge", "force_discharge")
    { capabilityId: 'measure_rssi', settingId: null },                                              // WiFi signal strength (In dBm)
    { capabilityId: 'measure_power.a', settingId: null },                                           // Phase A power (in W)
    { capabilityId: 'measure_power.b', settingId: null },                                           // Phase B power (in W)
    { capabilityId: 'measure_power.c', settingId: null },                                           // Phase C power (in W)
    { capabilityId: 'measure_power.total', settingId: null },                                       // Total power (in W)
    { capabilityId: 'measure_ct_state', settingId: null },                                          // CT status (0: not connected, 1: connected)
];

/**
 * Represents a Marstek Venus device connected locally via UDP.
 * The device listens for broadcast messages, keeps capabilities in sync,
 * and exposes polling controls.
 * @extends Homey.Device
 */
export default class MarstekVenusLocalApiDevice extends Homey.Device {

    // Handler bound to the socket listener so it can be registered/unregistered.
    private handler = this.onMessage.bind(this);

    // Identifier for the interval that updates the last received timestamp.
    private timeout?: NodeJS.Timeout = undefined;

    // Cast pointer to our app
    private myDriver: MarstekVenusLocalApiDriver = this.driver as MarstekVenusLocalApiDriver;

    // Timestamp last received details
    private timestamp?: Date = undefined;

    /**
     * Called by Homey when the device is initialized.
     * Starts listening to the shared UDP socket, resets capabilities,
     * and schedules background polling.
     * @returns {Promise<void>} Resolves once startup work completes.
     */
    async onInit() {
        if (this.debug) {
            this.log('MarstekVenusLocalApiDevice has been initialized');
            this.log('Device settings', JSON.stringify(this.getSettings()));
        }

        // Start listening on UDP server on driver
        await this.startListening();

        // Default capability values
        await this.resetCapabilities();

        // Register capability listeners
        await this.registerCapabilityListener('battery_mode', this.onCapabilityBatteryMode.bind(this));

        // Send initial requests to populate data immediately
        await this.sendInitialRequests();

        if (this.getSetting('poll') !== false) {
            // Update the driver interval
            this.myDriver.pollIntervalUpdate();
            // Start polling at regular intervals
            this.startPolling();
        }
    }

    /**
     * Resets the registered capabilities to `null` so they appear as unknown in Homey.
     * Also ensures each capability exists on the device, adding any that are missing
     * to support upgrades that introduce new capabilities.
     * @returns {Promise<void>} Resolves once all capabilities are synchronised.
     */
    async resetCapabilities() {
        const model: Array<string> = (this.getSetting('model') || 'default v0').split(' v');
        const factorDefaults = this.myDriver.retrieveFactorDefaults(model[0], Number(model[1]));
        const missingSettings: Array<Record<string, number>> = [];

        for (const cap of capabilities) {
            // Make sure capability exists
            const capId = cap.capabilityId;
            if (!this.hasCapability(capId)) await this.addCapability(capId);
            await this.setCapabilityValue(capId, null);

            // Also retrieve settings default factors
            const { settingId } = cap;
            if (settingId) {
                const settingValue = this.getSetting(settingId);
                if (!settingValue) {
                    const defaultValue = factorDefaults[settingId];
                    missingSettings.push({ [settingId]: defaultValue });
                }
            }
        }

        // Apply any missing settings with default values
        if (missingSettings.length > 0) {
            await this.setSettings(Object.assign({}, ...missingSettings));
            if (this.debug) this.log('Missing settings:', JSON.stringify(Object.assign({}, ...missingSettings)));
            const newSettings = this.getSettings();
            if (this.debug) this.log('New settings:', JSON.stringify(newSettings));
        }
    }

    /**
     * Registers the UDP message listener for this device on the shared socket.
     * @returns {Promise<void>} Resolves when the listener has been registered.
     */
    async startListening() {
        if (this.debug) this.log('Start listening');
        this.myDriver.getSocket().on(this.handler);
    }

    /**
     * Removes the UDP message listener for this device from the shared socket.
     */
    stopListening() {
        if (this.debug) this.log('Stop listening');
        this.myDriver.getSocket().off(this.handler);
    }

    /**
     * Starts the periodic polling routine for the device.
     * The driver initiates UDP broadcasts and an interval keeps the
     * `last_message_received` capability updated.
     */
    startPolling() {
        if (this.debug) this.log('Start polling');
        this.myDriver.pollStart(this.getSetting('src'));
        // Also start updating the last received message capability
        this.timeout = this.homey.setInterval(async () => {
            if (this.timestamp) {
                const now = new Date();
                const diff = (now.getTime() - this.timestamp.getTime());
                await this.setCapabilityValue('last_message_received', Math.round(diff / 1000));
            }
        }, 5000);
    }

    /**
     * Stops the periodic polling routine and clears the update interval.
     */
    stopPolling() {
        if (this.debug) this.log('Stop polling');
        this.myDriver.pollStop(this.getSetting('src'));
        if (this.timeout) this.homey.clearInterval(this.timeout);
    }

    /**
     * Handles incoming UDP messages received by the shared socket.
     * Updates device state when the payload belongs to this device and
     * exposes diagnostic information when debug logging is enabled.
     * @param {any} json JSON payload received from the UDP socket.
     * @param {any} remote Metadata describing the remote sender (e.g. address).
     * @returns {Promise<void>} Resolves once the payload has been processed.
     */
    async onMessage(json: any, remote: dgram.RemoteInfo) {

        // Check if device is still present
        if (!this.getAvailable()) {
            this.error('Device is deleted or not available (yet)');
            return;
        }
        try {
            // Check if src property exists
            if (!json) {
                this.error('Received message without json', JSON.stringify(remote));
                return;
            }
            if (!json.src) {
                this.error('Received message without src property', JSON.stringify(json), JSON.stringify(remote));
                return;
            }

            // Check if message is for this instance (only)
            if (json.src !== this.getSetting('src')) {
                if (this.debug) this.log('Source mismatch (expected >1 devices)', this.getSetting('src'), JSON.stringify(remote), JSON.stringify(json));
                return;
            }

            // Debug received details (if requested)
            if (this.debug) this.log(`Received for ${json.src}:`, JSON.stringify(json), JSON.stringify(remote));

            // Update remote IP address of device (can change due to DHCP leases)
            if (remote.address) {
                await this.setStoreValue('address', remote.address);
                await this.setSettings({ address: remote.address });
            }

            // Determine the capabilities to changed based on the content of the received message
            if (json.result) {
                const { result } = json;

                // Remember our timestamp for last message received
                this.timestamp = new Date();
                await this.setCapabilityValue('last_message_received', 0);       // number of seconds the last received message

                // Main battery temperature (In degrees celcius)
                await this.setValue('measure_temperature', result.bat_temp);

                // Power remaining (In kWh)
                await this.setValue('meter_power', result.bat_capacity);

                // Battery state of charge
                await this.setValue('measure_battery', result.bat_soc);

                // Battery power and charging state
                if (!Number.isNaN(Number(result.bat_power))) {
                    // Charge state (Possible values: "idle", "charging", "discharging")
                    let chargingState = 'idle';
                    if (result.bat_power > 0) chargingState = 'charging';
                    if (result.bat_power < 0) chargingState = 'discharging';
                    await this.setCapabilityValue('battery_charging_state', chargingState);
                    await this.setValue('measure_power', result.bat_power);
                }

                // Input and output energy (kWh)
                await this.setValue('meter_power.imported', result.total_grid_input_energy);
                await this.setValue('meter_power.exported', result.total_grid_output_energy);
                await this.setValue('meter_power.load', result.total_load_energy);

                // Additional capabilities as communicated by Marstek to display in Homey (Watt)
                await this.setValue('measure_power_ongrid', result.ongrid_power);
                await this.setValue('measure_power_offgrid', result.offgrid_power);
                await this.setValue('measure_power_pv', result.pv_power);

                // WIFI status
                if (!isNaN(result.rssi)) {
                    if (this.debug) this.log('Setting RSSI capability:', result.rssi);
                    await this.setCapabilityValue('measure_rssi', result.rssi);
                }
                if (result.ssid) await this.setSettings({ wifi_ssid: result.ssid });
                if (result.sta_ip) await this.setSettings({ wifi_ip: result.sta_ip });
                if (result.sta_gate) await this.setSettings({ wifi_gateway: result.sta_gate });
                if (result.sta_mask) await this.setSettings({ wifi_subnet: result.sta_mask });
                if (result.sta_dns) await this.setSettings({ wifi_dns: result.sta_dns });

                // Current battery mode
                if (result.mode) {
                    const mode = result.mode.toLowerCase();
                    // Only set battery_mode if it's a setable mode
                    if (['ai', 'auto', 'force_charge', 'force_discharge'].includes(mode)) {
                        await this.setCapabilityValue('battery_mode', mode);
                    }
                }

                // EM status
                if (result.ct_state !== undefined) {
                    const currentCtState = await this.getCapabilityValue('measure_ct_state');
                    const newCtState = result.ct_state.toString();
                    if (currentCtState !== newCtState) {
                        await this.setCapabilityValue('measure_ct_state', newCtState);
                        // Trigger flow
                        await this.homey.flow.getTriggerCard('marstek_ct_state_changed').trigger(this, { state: result.ct_state });
                    }
                }
                if (!isNaN(result.a_power)) await this.setCapabilityValue('measure_power.a', result.a_power);
                if (!isNaN(result.b_power)) await this.setCapabilityValue('measure_power.b', result.b_power);
                if (!isNaN(result.c_power)) await this.setCapabilityValue('measure_power.c', result.c_power);
                if (!isNaN(result.total_power)) await this.setCapabilityValue('measure_power.total', result.total_power);
            }
        } catch (error) {
            this.error('Error processing incoming message:', error);

        }
    }

    /**
     * Sets the capability value for this device, taken the factor from settings into account.
     * @returns {Promise<void>} Resolves once the value has been set.
     */
    async setValue(capabilityId: string, value: any) {
        if (!Number.isNaN(Number(value))) {
            const settingId = capabilities.find((cap) => cap.capabilityId === capabilityId)?.settingId;
            const settingValue = settingId ? this.getSetting(settingId) : null;
            const actualValue = value / (settingValue || 1);
            if (this.debug && actualValue) {
                this.log('Capability value:', JSON.stringify({
                    capabilityId, settingId, settingValue, value, actualValue,
                }));
            }
            await this.setCapabilityValue(capabilityId, actualValue);
        }
    }

    /**
     * Called by Homey when settings are changed. Will make sure that polling is disabled according to setting.
     * @param {any} event Homey populated structure with old and new sttings
     */
    async onSettings(event: any) {
        // If polling setting is changed, start or stop polling
        if (event.changedKeys.includes('poll')) {
            if (event.newSettings.poll !== false) {
                this.startPolling();
            } else {
                this.stopPolling();
                await this.resetCapabilities();
            }
        }
        // If interval is changed, schedule a poll interval update because settings is not yet changed
        if (event.changedKeys.includes('interval')) {
            this.homey.setTimeout(() => {
                this.myDriver.pollIntervalUpdate();
            }, 1000);
        }
        // If factor settings are changed, reset capabilities to force recalculation on next message
        if (event.changedKeys.some((key: string) => key.startsWith('factor_'))) {
            await this.resetCapabilities();
        }
    }

    /**
     * Called when the user removes the device from Homey.
     * Cleans up polling and socket listeners.
     * @returns {Promise<void>} Resolves once cleanup finishes.
     */
    async onDeleted() {
        this.stopPolling();
        this.stopListening();
        if (this.debug) this.log('MarstekVenusLocalApiDevice has been deleted');
    }

    /**
     * Called when the device instance is uninitialised by Homey.
     * Cleans up background resources similar to {@link MarstekVenusLocalApiDevice#onDeleted}.
     * @returns {Promise<void>} Resolves once cleanup completes.
     */
    async onUninit() {
        this.stopPolling();
        this.stopListening();
        if (this.debug) this.log('MarstekVenusLocalApiDevice has been uninitialized');
    }

    /**
     * Send a command to the battery device.
     * @param {object} command JSON command to send
     */
    async sendCommand(command: object) {
        const address = this.getStoreValue('address');
        if (!address) {
            this.error('No address stored for device');
            return;
        }
        const message = JSON.stringify(command);
        await this.myDriver.getSocket().send(message, address);
    }

    /**
     * Send initial requests to populate data immediately after device addition.
     */
    async sendInitialRequests() {
        const socket = this.myDriver.getSocket();
        if (!socket) return;

        const messages = [
            '{"id":1,"method":"ES.GetStatus","params":{"id":0}}',
            '{"id":2,"method":"ES.GetMode","params":{"id":0}}',
            '{"id":3,"method":"EM.GetStatus","params":{"id":0}}'
        ];

        for (const msg of messages) {
            try {
                await socket.broadcast(msg);
                await new Promise(resolve => setTimeout(resolve, 500)); // delay between requests
            } catch (err) {
                this.error('Error sending initial request', err);
            }
        }
    }

    /**
     * Handle battery_mode capability changes.
     * @param {string} value The new mode value
     */
    async onCapabilityBatteryMode(value: string) {
        if (this.debug) this.log('Setting battery mode to', value);
        switch (value) {
            case 'ai':
                await this.myDriver.setModeManualDisable(this);
                await this.myDriver.setModeAI(this);
                break;
            case 'auto':
                await this.myDriver.setModeManualDisable(this);
                await this.myDriver.setModeAuto(this);
                break;
            case 'force_charge':
                const chargePower = this.getSetting('force_charge_power') || 2500;
                await this.myDriver.setModeManual(this, "00:01", "23:59", ["1", "2", "3", "4", "5", "6", "7"], -chargePower, true);
                break;
            case 'force_discharge':
                const dischargePower = this.getSetting('force_discharge_power') || 800;
                await this.myDriver.setModeManual(this, "00:01", "23:59", ["1", "2", "3", "4", "5", "6", "7"], dischargePower, true);
                break;
            default:
                throw new Error(`Unknown mode: ${value}`);
        }
    }

    /** Retrieve our current debug setting, based on actual setting and version
     * @returns {boolean} True when debug logging is enabled (through settings or test version)
     */
    get debug(): boolean {
        return (this.getSetting('debug') === true) || config.isTestVersion;
    }

}

// Also use module.exports for Homey
module.exports = MarstekVenusLocalApiDevice;
