import Homey from 'homey';
import type MarstekVenusCloudDriver from './driver';
import type MarstekCloud from '../../lib/marstek-cloud';

// Import our loaded config
import { config } from '../../lib/config';

/**
 * Represents a Marstek Venus device connected via the Marstek cloud APIs.
 * Handles authentication, capability updates and periodic polling of cloud status.
 * @extends Homey.Device
 */
export default class MarstekVenusCloudDevice extends Homey.Device {

    // Private properties
    private username?: string = undefined;
    private password?: string = undefined; // Stored as MD5 Encoded
    private devid?: string = undefined; // unique device id received from cloud
    private client?: MarstekCloud = undefined;
    private pollInterval?: NodeJS.Timeout = undefined;  // handle for interval used for polling data
    private lastInterval?: NodeJS.Timeout = undefined;  // handle for interval used for updating last message received

    // Timestamp last received details
    private timestamp?: Date = undefined;

    // Cast pointers to our app
    private myDriver: MarstekVenusCloudDriver = this.driver as MarstekVenusCloudDriver;

    /**
     * Called when the device is initialised.
     * Loads credentials, initialises the shared cloud client, resets capabilities,
     * and starts the polling cycle.
     * @returns {Promise<void>} Resolves once initialisation completes.
     */
    async onInit() {
        if (this.debug) this.log('MarstekVenusCloudDevice has been initialized');
        await this.loadConfiguration();
        await this.initialiseClient();
        await this.updateCapabilitiesWithNull();
        await this.startPolling();
    }

    /**
     * Called after the device has been added to Homey.
     * Currently used for debug logging only.
     * @returns {Promise<void>} Resolves once logging completes.
     */
    async onAdded() {
        if (this.debug) this.log('MarstekVenusCloudDevice has been added');
    }

    /**
     * Called when the device is removed by the user.
     * Stops background polling and logs the action when debug is enabled.
     * @returns {Promise<void>} Resolves once cleanup completes.
     */
    async onDeleted() {
        this.stopPolling();
        if (this.debug) this.log('MarstekVenusCloudDevice has been deleted');
    }

    /**
     * Called when Homey uninitialises the device.
     * Ensures polling is stopped to free up resources.
     * @returns {Promise<void>} Resolves once cleanup completes.
     */
    async onUninit() {
        this.stopPolling();
        if (this.debug) this.log('MarstekVenusCloudDevice has been uninitialized');
    }

    /**
     * Loads the credentials and device identifier from Homey's store.
     * @returns {Promise<void>} Resolves once configuration values are retrieved.
     * @throws {Error} When required credentials are missing.
     */
    private async loadConfiguration() {
        // Load credentials from store
        this.username = await this.getStoreValue('username');
        this.password = await this.getStoreValue('password');
        this.devid = await this.getStoreValue('devid');

        if (!this.username || !this.password || !this.devid) {
            throw new Error('Missing cloud account credentials or device details. Please re-pair (remove and add) the device.');
        }
    }

    /**
     * Retrieves or creates the Marstek cloud client for the stored credentials and ensures it is authenticated.
     * @returns {Promise<void>} Resolves once the client is authenticated.
     * @throws {Error} When authentication fails.
     */
    private async initialiseClient() {
        // Retrieve client related to the current credentials
        this.client = this.myDriver.getClient(
            {
                username: this.username,
                password: this.password,
            },
        );

        if (!this.client) {
            this.error('[cloud] No client available for these credentials');
            await this.setUnavailable('Unable to authenticate with Marstek cloud');
        }
    }

    /**
     * Resets the relevant device capabilities to `null` until fresh data is received.
     * @returns {Promise<void>} Resolves once capability values are cleared.
     */
    private async updateCapabilitiesWithNull() {
        await this.setCapabilityValue('measure_battery', null);
        await this.setCapabilityValue('measure_power', null);
        await this.setCapabilityValue('measure_power.charge', null);
        await this.setCapabilityValue('measure_power.discharge', null);
        await this.setCapabilityValue('last_message_received', null);
    }

    /**
     * Starts the polling cycle that retrieves cloud data and updates the last message capability.
     */
    private async startPolling() {
        // Start retrieving details from cloud service
        if (this.pollInterval) return;
        if (this.debug) this.log('[cloud] polling started');

        // Poll every 60 seconds
        this.pollInterval = this.homey.setInterval(() => this.poll(), 60000);

        // Initial poll
        await this.poll();

        // Also start updating the last received message capability
        this.lastInterval = this.homey.setInterval(async () => {
            if (this.timestamp) {
                const now = new Date();
                const diff = (now.getTime() - this.timestamp.getTime());
                await this.setCapabilityValue('last_message_received', Math.round(diff / 1000));
            }
        }, 5000);

    }

    /**
     * Stops the polling cycle and clears both the poll and last-message intervals.
     */
    private stopPolling() {
        if (this.pollInterval) {
            if (this.debug) this.log('[cloud] polling stopped');
            this.homey.clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
        if (this.lastInterval) this.homey.clearInterval(this.lastInterval);
    }

    /**
     * Executes a single poll by requesting device status from the cloud API and updating capabilities.
     * @returns {Promise<void>} Resolves when the capability updates complete.
     */
    private async poll() {
        try {
            // retrieve data of all devices
            const payload = await this.client?.fetchDeviceStatus();

            // Filter correct device
            const status = payload?.find((device: any) => device.devid === this.devid);
            if (status) {
                await this.handleStatusPayload(status);
                if (!this.getAvailable()) await this.setAvailable();
            } else {
                this.error('[cloud] Device details not found in payload for device', this.devid);
                await this.updateCapabilitiesWithNull();
            }
        } catch (err) {
            this.error('[cloud] Error fetching Marstek cloud data:', (err as Error).message || err);
            await this.setUnavailable('Unable to reach Marstek cloud.');
        }
    }

    /**
     * Processes the payload returned from the cloud API and updates device capabilities.
     * @param {any} status - Raw status payload returned by the cloud API.
     * @returns {Promise<void>} Resolves once the capability values have been updated.
     */
    private async handleStatusPayload(status: any) {
        if (!status) {
            this.error('[cloud] Payload not found or no data in payload', status);
            return;
        }
        if (this.debug) this.log('[cloud] Device payload to proces', JSON.stringify(status));

        // Log report time
        this.timestamp = new Date(status.report_time * 1000);
        if (this.debug) this.log('[cloud] Last cloud update:', new Date(status.report_time * 1000));

        // State of Charge (%)
        if (!Number.isNaN(Number(status.soc))) {
            await this.setCapabilityValue('measure_battery', status.soc);
        }

        // Power (charge minus discharge)
        await this.setCapabilityValue('measure_power', status.charge - status.discharge);
        await this.setCapabilityValue('measure_power.charge', status.charge);
        await this.setCapabilityValue('measure_power.discharge', status.discharge);
    }

    /** Retrieve our current debug setting, based on actual setting and version */
    get debug(): boolean {
        return (this.getSetting('debug') === true) || config.isTestVersion;
    }

}

// Also use module.exports for Homey
module.exports = MarstekVenusCloudDevice;
