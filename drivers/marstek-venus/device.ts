import Homey from 'homey';
import dgram from 'dgram'; // For UDP binding and sending
import MarstekVenusDriver from './driver';

// Import our loaded config
import { config } from '../../lib/config';

// Import statistics utilities
import {
  StatisticsEntry, cleanupOldEntries, aggregateDailyStats, calculateDetailedBreakdown,
  logStatisticsEntry, getCalculationAuditTrail,
} from '../../lib/statistics-utils';

/**
 * Represents a Marstek Venus device connected locally via UDP.
 * The device listens for broadcast messages, keeps capabilities in sync,
 * and exposes polling controls.
 * @extends Homey.Device
 */
export default class MarstekVenusDevice extends Homey.Device {

    // Handler bound to the socket listener so it can be registered/unregistered.
    private handler = this.onMessage.bind(this);

    // Identifier for the interval that updates the last received timestamp.
    private timeout?: NodeJS.Timeout = undefined;

    // Cast pointer to our app
    private myDriver: MarstekVenusDriver = this.driver as MarstekVenusDriver;

    // Timestamp last received details
    private timestamp?: Date = undefined;

    // Statistics tracking
    private previousInputEnergy?: number = undefined;
    private previousOutputEnergy?: number = undefined;
    private lastMessageTime?: Date = undefined;

    /**
     * Called by Homey when the device is initialized.
     * Starts listening to the shared UDP socket, resets capabilities,
     * and schedules background polling.
     * @returns {Promise<void>} Resolves once startup work completes.
     */
    async onInit() {
      if (this.debug) {
        this.log('MarstekVenusDevice has been initialized');
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
      const capabilities = [
        'battery_charging_state', // Charte state (Possible values: "idle", "charging", "discharging")
        'battery_mode', // Battery mode (Possible values: "ai", "auto", "force_charge", "force_discharge")
        'meter_power', // Power remaining (In kWh)
        'measure_power', // Power usage/delivery (In Watts)
        'measure_temperature', // Main battery temperature (In degrees celcius)
        'measure_battery', // State of Charge in %
        'measure_rssi', // WiFi signal strength (In dBm)
        'meter_power.imported', // Total power imported (in kWh)
        'meter_power.exported', // Total power exported (in kWh)
        'meter_power.load', // Total power exported (in kWh)
        'measure_power_ongrid', // Current power usage of on-grid port (in W)
        'measure_power_offgrid', // Current power usage of off-grid port (in W)
        'measure_power_pv', // Current power usage of off-grid port (in W)
        'last_message_received', // number of seconds the last received message
        'measure_power.a', // Phase A power (in W)
        'measure_power.b', // Phase B power (in W)
        'measure_power.c', // Phase C power (in W)
        'measure_power.total', // Total power (in W)
        'measure_ct_state', // CT status (0: not connected, 1: connected)
        'measure_battery_profit_daily', // Daily profit in currency
        'measure_battery_profit_hourly', // Hourly profit rate in currency per hour
        'measure_battery_charge_energy_daily', // Daily charge energy in kWh
        'measure_battery_discharge_energy_daily', // Daily discharge energy in kWh
        'measure_battery_savings_daily', // Daily savings in currency
        'measure_battery_cost_daily', // Daily cost in currency
        'measure_battery_net_profit_daily', // Daily net profit in currency
        'measure_calculation_timestamp', // Timestamp of last calculation
        'measure_current_energy_price', // Current energy price used for calculations
        'measure_calculation_method', // Current calculation method
      ];
      for (const cap of capabilities) {
        if (!this.hasCapability(cap)) await this.addCapability(cap);
        await this.setCapabilityValue(cap, null);
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
        if (remote.address) this.setStoreValue('address', remote.address);

        // Try to retrieve the firmware version from the settings (including deprecated method)
        let firmware = 0;
        if (this.getSetting('firmware')) {
          firmware = Number(this.getSetting('firmware'));
        } else {
          const model = this.getSetting('model');
          if (model) firmware = Number(model.split(' v')[1]);
        }

        // Determine the capabilities to changed based on the content of the received message
        if (json.result) {
          const { result } = json;

          // Remember our timestamp for last message received
          this.timestamp = new Date();
          await this.setCapabilityValue('last_message_received', 0); // number of seconds the last received message

          // Main battery temperature (In degrees celcius)
          if (!isNaN(result.bat_temp)) {
            // TODO: figure out what the actual multipliers are per firmware, for now, use sanity check
            if (result.bat_temp > 50) result.bat_temp /= 10.0;
            await this.setCapabilityValue('measure_temperature', result.bat_temp);
          }

          // Power remaining (In kWh)
          if (!isNaN(result.bat_capacity)) await this.setCapabilityValue('meter_power', result.bat_capacity / ((firmware >= 154) ? 1000.0 : 100.0));

          // Battery state of charge
          if (!isNaN(result.bat_soc)) await this.setCapabilityValue('measure_battery', result.bat_soc);

          // Battery power and charging state
          if (!isNaN(result.bat_power)) {
            // Charge state (Possible values: "idle", "charging", "discharging")
            await this.setCapabilityValue('battery_charging_state', (result.bat_power > 0) ? 'charging' : (result.bat_power < 0) ? 'discharging' : 'idle');
            await this.setCapabilityValue('measure_power', result.bat_power / ((firmware >= 154) ? 1.0 : 10.0));
          }

          // Input and output energy (kWh)
          if (!isNaN(result.total_grid_input_energy)) await this.setCapabilityValue('meter_power.imported', result.total_grid_input_energy / ((firmware >= 154) ? 10.0 : 100.0));
          if (!isNaN(result.total_grid_output_energy)) await this.setCapabilityValue('meter_power.exported', result.total_grid_output_energy / ((firmware >= 154) ? 10.0 : 100.0));
          if (!isNaN(result.total_load_energy)) await this.setCapabilityValue('meter_power.load', result.total_load_energy / ((firmware >= 154) ? 10.0 : 100.0));

          // Additional capabilities as communicated by Marstek to display in Homey (Watt)
          if (!isNaN(result.ongrid_power)) await this.setCapabilityValue('measure_power_ongrid', result.ongrid_power * -1);
          if (!isNaN(result.offgrid_power)) await this.setCapabilityValue('measure_power_offgrid', result.offgrid_power * -1);
          if (!isNaN(result.pv_power)) await this.setCapabilityValue('measure_power_pv', result.pv_power * -1);

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
              await this.homey.flow.getTriggerCard('marstek_ct_state_changed').trigger({ state: result.ct_state });
            }
          }
          if (!isNaN(result.a_power)) await this.setCapabilityValue('measure_power.a', result.a_power);
          if (!isNaN(result.b_power)) await this.setCapabilityValue('measure_power.b', result.b_power);
          if (!isNaN(result.c_power)) await this.setCapabilityValue('measure_power.c', result.c_power);
          if (!isNaN(result.total_power)) await this.setCapabilityValue('measure_power.total', result.total_power);
        }

        // Log statistics for energy deltas
        if (this.getSetting('enable_statistics')) {
          const currentInput = await this.getCapabilityValue('meter_power.imported') || 0;
          const currentOutput = await this.getCapabilityValue('meter_power.exported') || 0;
          const now = new Date();
          const duration = this.lastMessageTime ? (now.getTime() - this.lastMessageTime.getTime()) / 60000 : 0;
          let firmware = 0;
          if (this.getSetting('firmware')) {
            firmware = Number(this.getSetting('firmware'));
          } else {
            const model = this.getSetting('model');
            if (model) firmware = Number(model.split(' v')[1]);
          }
          const divisor = (firmware >= 154) ? 10.0 : 100.0;
          if (this.previousInputEnergy !== undefined) {
            const deltaInput = currentInput - this.previousInputEnergy;
            if (deltaInput > 0) {
              const price = this.getCurrentEnergyPrice();
              const energyAmount = deltaInput / divisor;
              const entry: StatisticsEntry = {
                timestamp: Math.floor(now.getTime() / 1000),
                type: 'charging',
                energyAmount,
                duration,
                priceAtTime: price,
                startEnergyMeter: this.previousInputEnergy,
                endEnergyMeter: currentInput,
              };
              const calculationDetails = {
                method: 'delta_based',
                inputs: {
                  startMeter: this.previousInputEnergy,
                  endMeter: currentInput,
                  divisor,
                  duration,
                },
                intermediateSteps: [
                  `Delta: ${currentInput} - ${this.previousInputEnergy} = ${(currentInput - this.previousInputEnergy).toFixed(3)}`,
                  `Energy: ${(currentInput - this.previousInputEnergy) / divisor} kWh`,
                ],
              };
              logStatisticsEntry(entry, {
                debug: this.getSetting('statistics_debug'),
                transparency: this.getSetting('statistics_transparency'),
              }, this.log.bind(this), calculationDetails);
              await this.logStatisticsEntry(entry);
            }
          }
          if (this.previousOutputEnergy !== undefined) {
            const deltaOutput = currentOutput - this.previousOutputEnergy;
            if (deltaOutput > 0) {
              const price = this.getCurrentEnergyPrice();
              const energyAmount = deltaOutput / divisor;
              const entry: StatisticsEntry = {
                timestamp: Math.floor(now.getTime() / 1000),
                type: 'discharging',
                energyAmount: -energyAmount,
                duration,
                priceAtTime: price,
                startEnergyMeter: this.previousOutputEnergy,
                endEnergyMeter: currentOutput,
              };
              const calculationDetails = {
                method: 'delta_based',
                inputs: {
                  startMeter: this.previousOutputEnergy,
                  endMeter: currentOutput,
                  divisor,
                  duration,
                },
                intermediateSteps: [
                  `Delta: ${currentOutput} - ${this.previousOutputEnergy} = ${(currentOutput - this.previousOutputEnergy).toFixed(3)}`,
                  `Energy: ${(currentOutput - this.previousOutputEnergy) / divisor} kWh`,
                ],
              };
              logStatisticsEntry(entry, {
                debug: this.getSetting('statistics_debug'),
                transparency: this.getSetting('statistics_transparency'),
              }, this.log.bind(this), calculationDetails);
              await this.logStatisticsEntry(entry);
            }
          }
          this.previousInputEnergy = currentInput;
          this.previousOutputEnergy = currentOutput;
          this.lastMessageTime = now;
        }

        // Update profit capabilities if statistics are enabled
        if (this.getSetting('enable_statistics')) {
          await this.updateProfitCapabilities();
        }

      } catch (error) {
        this.error('Error processing incoming message:', error);
      }
    }

    /**
     * Verify statistics calculations for a given time period
     * @param {string} timePeriod Time period to verify (last_hour, last_day, last_week, last_month)
     * @param {boolean} includeDetails Whether to include detailed breakdown
     * @returns {Promise<string>} Verification report
     */
    async verifyCalculation(timePeriod: string, includeDetails: boolean): Promise<string> {
      const stats: StatisticsEntry[] = this.getStoreValue('statistics') || [];
      if (stats.length === 0) {
        return 'No statistics data available for verification';
      }

      // Calculate time range
      const now = Date.now();
      let startTime: number;
      switch (timePeriod) {
        case 'last_hour':
          startTime = now - (60 * 60 * 1000);
          break;
        case 'last_day':
          startTime = now - (24 * 60 * 60 * 1000);
          break;
        case 'last_week':
          startTime = now - (7 * 24 * 60 * 60 * 1000);
          break;
        case 'last_month':
          startTime = now - (30 * 24 * 60 * 60 * 1000);
          break;
        default:
          return 'Invalid time period';
      }

      const auditTrail = getCalculationAuditTrail(stats, startTime / 1000, now / 1000);

      let report = `Verification Report for ${timePeriod.replace('_', ' ').toUpperCase()}\n`;
      report += `Total entries: ${auditTrail.length}\n\n`;

      let validEntries = 0;
      let invalidEntries = 0;

      for (const item of auditTrail) {
        if (item.verification.energyValid && item.verification.profitValid && item.verification.timestampValid) {
          validEntries++;
        } else {
          invalidEntries++;
        }

        if (includeDetails) {
          report += `Entry: ${item.verification.details}\n`;
        }
      }

      report += `Valid entries: ${validEntries}\n`;
      report += `Invalid entries: ${invalidEntries}\n`;

      if (invalidEntries > 0) {
        report += '\nWarning: Some entries have validation issues. Check logs for details.\n';
      } else {
        report += '\nAll entries passed validation.\n';
      }

      return report;
    }

    /**
     * Called by Homey when settings are changed. Will make sure that polling is disabled according to setting.
     * @param {any} event Homey populated structure with old and new sttings
     */
    async onSettings(event: any) {
      if (event.changedKeys.includes('poll')) {
        if (event.newSettings.poll !== false) {
          this.startPolling();
        } else {
          this.stopPolling();
          this.resetCapabilities();
        }
      }
      // If interval is changed, schedule a poll interval update because settings is not yet changed
      if (event.changedKeys.includes('interval')) {
        this.homey.setTimeout(() => {
          this.myDriver.pollIntervalUpdate();
        }, 1000);
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
      if (this.debug) this.log('MarstekVenusDevice has been deleted');
    }

    /**
     * Called when the device instance is uninitialised by Homey.
     * Cleans up background resources similar to {@link MarstekVenusDevice#onDeleted}.
     * @returns {Promise<void>} Resolves once cleanup completes.
     */
    async onUninit() {
      this.stopPolling();
      this.stopListening();
      if (this.debug) this.log('MarstekVenusDevice has been uninitialized');
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
        '{"id":3,"method":"EM.GetStatus","params":{"id":0}}',
      ];

      for (const msg of messages) {
        try {
          await socket.broadcast(msg);
          await new Promise((resolve) => setTimeout(resolve, 500)); // delay between requests
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
          await this.myDriver.setModeManual(this, '00:01', '23:59', ['0', '1', '2', '3', '4', '5', '6'], -chargePower, true);
          break;
        case 'force_discharge':
          const dischargePower = this.getSetting('force_discharge_power') || 800;
          await this.myDriver.setModeManual(this, '00:01', '23:59', ['0', '1', '2', '3', '4', '5', '6'], dischargePower, true);
          break;
        default:
          throw new Error(`Unknown mode: ${value}`);
      }
    }

    /**
     * Get the current energy price from settings
     * @returns {number} Current energy price in €/kWh
     */
    getCurrentEnergyPrice(): number {
      const price = this.getSetting('price_per_kwh') ?? 0.30;
      this.log('Using energy price from settings:', price, '€/kWh');
      return price;
    }

    /**
     * Log a statistics entry
     * @param entry The statistics entry to log
     */
    async logStatisticsEntry(entry: StatisticsEntry) {
      let stats: StatisticsEntry[] = this.getStoreValue('statistics') || [];
      stats.push(entry);
      // Cleanup old entries
      const retentionDays = this.getSetting('statistics_retention_days') || 30;
      stats = cleanupOldEntries(stats, retentionDays);
      await this.setStoreValue('statistics', stats);
      if (this.debug) this.log('Logged statistics entry:', entry);

      // Trigger flow card for statistics entry logged
      const calculationDetails = {
        energyAmount: entry.energyAmount,
        duration: entry.duration,
        priceAtTime: entry.priceAtTime,
        startEnergyMeter: entry.startEnergyMeter,
        endEnergyMeter: entry.endEnergyMeter,
        calculationMethod: 'delta_based',
      };

      await this.homey.flow.getTriggerCard('statistics_entry_logged').trigger({
        timestamp: entry.timestamp,
        value: Math.abs(entry.energyAmount),
        calculation_details: JSON.stringify(calculationDetails),
        energy_price: entry.priceAtTime || 0,
        calculation_method: 'delta_based',
      }, {
        entryType: entry.type === 'charging' ? 'charge' : 'discharge',
      });

      // Trigger flow card for calculation completed
      await this.homey.flow.getTriggerCard('calculation_completed').trigger({
        calculationType: entry.type === 'charging' ? 'charge' : 'discharge',
        timestamp: entry.timestamp,
        result: Math.abs(entry.energyAmount),
        input_data: JSON.stringify({
          startEnergyMeter: entry.startEnergyMeter,
          endEnergyMeter: entry.endEnergyMeter,
          duration: entry.duration,
        }),
        energy_price: entry.priceAtTime,
        calculation_method: 'delta_based',
      }, {
        calculationType: entry.type === 'charging' ? 'charge' : 'discharge',
      });
    }

    /**
     * Update the profit capabilities based on aggregated statistics
     */
    async updateProfitCapabilities() {
      const stats: StatisticsEntry[] = this.getStoreValue('statistics') || [];
      if (stats.length === 0) {
        await this.setCapabilityValue('measure_battery_profit_daily', 0);
        await this.setCapabilityValue('measure_battery_profit_hourly', 0);
        await this.setCapabilityValue('measure_battery_charge_energy_daily', 0);
        await this.setCapabilityValue('measure_battery_discharge_energy_daily', 0);
        await this.setCapabilityValue('measure_battery_savings_daily', 0);
        await this.setCapabilityValue('measure_battery_cost_daily', 0);
        await this.setCapabilityValue('measure_battery_net_profit_daily', 0);
        return;
      }

      const dailyStats = aggregateDailyStats(stats);
      const today = new Date().toISOString().split('T')[0];
      const todayStat = dailyStats.find((ds) => ds.date === today);

      const dailyProfit = todayStat ? todayStat.totalProfit : 0;
      this.log('Calculated daily profit:', dailyProfit);
      await this.setCapabilityValue('measure_battery_profit_daily', dailyProfit);

      // Hourly profit: total daily profit divided by hours elapsed in the day
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const hoursElapsed = (now.getTime() - startOfDay.getTime()) / (1000 * 60 * 60);
      const hourlyProfit = (hoursElapsed > 0) ? dailyProfit / hoursElapsed : 0;
      this.log('Calculated hourly profit:', hourlyProfit);
      await this.setCapabilityValue('measure_battery_profit_hourly', hourlyProfit);

      // Update detailed breakdown capabilities
      const breakdown = calculateDetailedBreakdown(stats);

      if (this.getSetting('statistics_debug') || this.getSetting('statistics_transparency') || this.getSetting('show_calculation_details')) {
        this.log('Detailed breakdown calculation:');
        this.log('  Charge Energy:', breakdown.chargeEnergy, 'kWh');
        this.log('  Discharge Energy:', breakdown.dischargeEnergy, 'kWh');
        this.log('  Savings:', breakdown.savings, '€');
        this.log('  Cost:', breakdown.cost, '€');
        this.log('  Net Profit:', breakdown.netProfit, '€');
      }

      await this.setCapabilityValue('measure_battery_charge_energy_daily', breakdown.chargeEnergy);
      await this.setCapabilityValue('measure_battery_discharge_energy_daily', breakdown.dischargeEnergy);
      await this.setCapabilityValue('measure_battery_savings_daily', breakdown.savings);
      await this.setCapabilityValue('measure_battery_cost_daily', breakdown.cost);
      await this.setCapabilityValue('measure_battery_net_profit_daily', breakdown.netProfit);

      // Update real-time calculation display capabilities
      const currentPrice = this.getCurrentEnergyPrice();
      await this.setCapabilityValue('measure_current_energy_price', currentPrice);
      await this.setCapabilityValue('measure_calculation_method', 'delta_based');
      await this.setCapabilityValue('measure_calculation_timestamp', Math.floor(Date.now() / 1000));
    }

    /** Retrieve our current debug setting, based on actual setting and version
     * @returns {boolean} True when debug logging is enabled (through settings or test version)
     */
    get debug(): boolean {
      return (this.getSetting('debug') === true) || config.isTestVersion;
    }

    /**
     * Export statistics data in JSON or CSV format
     * @param {string} format Export format (json or csv)
     * @param {string} timeRange Time range (daily, monthly, yearly)
     * @returns {Promise<string>} Exported data as string
     */
    async exportStatistics(format: string, timeRange: string): Promise<string> {
      const stats: StatisticsEntry[] = this.getStoreValue('statistics') || [];
      if (stats.length === 0) {
        return format === 'json' ? '{"error": "No statistics data available"}' : 'Error: No statistics data available';
      }

      let exportData: any[] = [];

      if (timeRange === 'daily') {
        const dailyStats = aggregateDailyStats(stats);
        exportData = dailyStats.map((ds) => ({
          date: ds.date,
          chargeEnergy: ds.totalChargeEnergy,
          dischargeEnergy: ds.totalDischargeEnergy,
          totalProfit: ds.totalProfit,
        }));
      } else if (timeRange === 'monthly') {
        // Group by month
        const monthlyStats = new Map<string, { chargeEnergy: number; dischargeEnergy: number; totalProfit: number }>();
        stats.forEach((entry) => {
          const date = new Date(entry.timestamp);
          const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          if (!monthlyStats.has(monthKey)) {
            monthlyStats.set(monthKey, { chargeEnergy: 0, dischargeEnergy: 0, totalProfit: 0 });
          }
          const current = monthlyStats.get(monthKey)!;
          if (entry.type === 'charging') {
            current.chargeEnergy += entry.energyAmount;
            current.totalProfit -= entry.energyAmount * (entry.priceAtTime || 0);
          } else {
            current.dischargeEnergy += Math.abs(entry.energyAmount);
            current.totalProfit += Math.abs(entry.energyAmount) * (entry.priceAtTime || 0);
          }
        });
        exportData = Array.from(monthlyStats.entries()).map(([month, data]) => ({
          month,
          chargeEnergy: data.chargeEnergy,
          dischargeEnergy: data.dischargeEnergy,
          totalProfit: data.totalProfit,
        }));
      } else if (timeRange === 'yearly') {
        // Group by year
        const yearlyStats = new Map<string, { chargeEnergy: number; dischargeEnergy: number; totalProfit: number }>();
        stats.forEach((entry) => {
          const date = new Date(entry.timestamp);
          const yearKey = date.getFullYear().toString();
          if (!yearlyStats.has(yearKey)) {
            yearlyStats.set(yearKey, { chargeEnergy: 0, dischargeEnergy: 0, totalProfit: 0 });
          }
          const current = yearlyStats.get(yearKey)!;
          if (entry.type === 'charging') {
            current.chargeEnergy += entry.energyAmount;
            current.totalProfit -= entry.energyAmount * (entry.priceAtTime || 0);
          } else {
            current.dischargeEnergy += Math.abs(entry.energyAmount);
            current.totalProfit += Math.abs(entry.energyAmount) * (entry.priceAtTime || 0);
          }
        });
        exportData = Array.from(yearlyStats.entries()).map(([year, data]) => ({
          year,
          chargeEnergy: data.chargeEnergy,
          dischargeEnergy: data.dischargeEnergy,
          totalProfit: data.totalProfit,
        }));
      }

      if (format === 'json') {
        return JSON.stringify(exportData, null, 2);
      }
      // CSV format
      const headers = Object.keys(exportData[0] || {});
      const csvRows = [headers.join(',')];
      exportData.forEach((row) => {
        const values = headers.map((header) => row[header]);
        csvRows.push(values.join(','));
      });
      return csvRows.join('\n');

    }

}

// Also use module.exports for Homey
module.exports = MarstekVenusDevice;
