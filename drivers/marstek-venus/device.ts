import Homey from 'homey';
import dgram from 'dgram'; // For UDP binding and sending
import MarstekVenusDriver from './driver';

// Import our loaded config
import { config } from '../../lib/config';

// Import statistics utilities with enhanced safety features
import {
  StatisticsEntry, cleanupOldEntries, aggregateDailyStats, calculateDetailedBreakdown,
  logStatisticsEntry, getCalculationAuditTrail, getStatisticsSummary, calculateProfitSavings,
} from '../../lib/statistics-utils';

import {
  GridCounterAccumulatorState,
  updateGridCounterAccumulator,
} from '../../lib/grid-counter-accumulator';

// Import validation utilities
import {
  validateEnergyPrice as validateEnergyPriceUtil,
} from '../../lib/financial-calculator';

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

    // Statistics tracking (grid counter based)
    private static readonly GRID_COUNTER_ACCUMULATOR_STORE_KEY = 'grid_counter_accumulator';

    // Lock to prevent race conditions in statistics operations
    private statisticsLock: boolean = false;

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
        const { result } = json;
        if (result) {

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
            this.log('[stats] Battery power:', result.bat_power);
            await this.setCapabilityValue('battery_charging_state', (result.bat_power > 0) ? 'charging' : (result.bat_power < 0) ? 'discharging' : 'idle');
            await this.setCapabilityValue('measure_power', result.bat_power / ((firmware >= 154) ? 1.0 : 10.0));
          }

          // Input and output energy (kWh)
          const divisor = (firmware >= 154) ? 10.0 : 100.0;
          if (this.debug) this.log('Firmware:', firmware, 'divisor:', divisor);
          if (!isNaN(result.total_grid_input_energy)) {
            if (this.debug) this.log('Raw total_grid_input_energy:', result.total_grid_input_energy);
            const value = result.total_grid_input_energy / divisor;
            await this.setCapabilityValue('meter_power.imported', value);
            if (this.debug) this.log('Setting meter_power.imported to:', value, 'from raw:', result.total_grid_input_energy, 'divisor:', divisor);
          }
          if (!isNaN(result.total_grid_output_energy)) {
            if (this.debug) this.log('Raw total_grid_output_energy:', result.total_grid_output_energy);
            const value = result.total_grid_output_energy / divisor;
            await this.setCapabilityValue('meter_power.exported', value);
            if (this.debug) this.log('Setting meter_power.exported to:', value, 'from raw:', result.total_grid_output_energy, 'divisor:', divisor);
          }
          if (!isNaN(result.total_load_energy)) await this.setCapabilityValue('meter_power.load', result.total_load_energy / divisor);

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

          // Statistics/profit calculation: strictly based on authoritative grid counters
          if (this.getSetting('enable_statistics')) {
            await this.processGridCounterStatistics(result, divisor);
            await this.updateProfitCapabilities();
          }
        }
      } catch (error) {
        this.error('Error processing incoming message:', error);
      }
    }

    /**
     * Updates the statistics store by accumulating deltas from authoritative grid counters.
     *
     * Authoritative fields:
     * - result.total_grid_input_energy  (grid import cumulative counter)
     * - result.total_grid_output_energy (grid export cumulative counter)
     *
     * Notes:
     * - We do NOT read back `meter_power.imported/exported` from Homey capabilities because
     *   capability storage/UI may round values (causing incorrect deltas).
     * - To prevent memory growth, we flush at most once per hour (and at UTC day boundaries).
     */
    private async processGridCounterStatistics(result: any, divisorRawPerKwh: number): Promise<void> {
      if (this.debug) this.log('enable_statistics is enabled, processing grid counter statistics');

      // Wait for lock to be released if another operation is in progress
      while (this.statisticsLock) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Acquire lock
      this.statisticsLock = true;

      try {
        const now = new Date();
        const nowSec = Math.floor(now.getTime() / 1000);

        const currentInputRaw = Number(result.total_grid_input_energy);
        const currentOutputRaw = Number(result.total_grid_output_energy);

        if (!Number.isFinite(currentInputRaw) || !Number.isFinite(currentOutputRaw)) {
          if (this.debug) this.log('Grid counters missing/invalid in payload, skipping statistics');
          return;
        }

        // Log raw energy counters
        if (this.debug) this.log('[P&L] Raw energy counters: input=', currentInputRaw, ', output=', currentOutputRaw);

        const price = this.getCurrentEnergyPrice();
        const priceValidation = validateEnergyPriceUtil(price);
        if (!priceValidation.isValid) {
          this.error(`Invalid energy price: ${priceValidation.error}`);
          return;
        }

        const storedState: GridCounterAccumulatorState | null = this.getStoreValue(MarstekVenusDevice.GRID_COUNTER_ACCUMULATOR_STORE_KEY) || null;

        if (this.debug && storedState && nowSec > storedState.lastTimestampSec) {
          const deltaInputRaw = currentInputRaw - storedState.lastInputRaw;
          const deltaOutputRaw = currentOutputRaw - storedState.lastOutputRaw;
          if (deltaInputRaw >= 0) {
            this.log(
              '[P&L] Computed input energy delta:',
              deltaInputRaw / divisorRawPerKwh,
              'kWh (raw:',
              deltaInputRaw,
              'current:',
              currentInputRaw,
              'previous:',
              storedState.lastInputRaw,
              ')',
            );
          }
          if (deltaOutputRaw >= 0) {
            this.log(
              '[P&L] Computed output energy delta:',
              deltaOutputRaw / divisorRawPerKwh,
              'kWh (raw:',
              deltaOutputRaw,
              'current:',
              currentOutputRaw,
              'previous:',
              storedState.lastOutputRaw,
              ')',
            );
          }
        }

        const update = updateGridCounterAccumulator(storedState, {
          timestampSec: nowSec,
          inputRaw: currentInputRaw,
          outputRaw: currentOutputRaw,
          divisorRawPerKwh,
        }, {
          flushIntervalMinutes: 60,
        });

        if (this.debug && update.reason && update.reason !== 'no_flush') {
          this.log('[grid_counters] accumulator update:', update.reason);
        }

        if (update.flush) {
          const {
            startTimestampSec,
            endTimestampSec,
            durationMinutes,
            startInputRaw,
            endInputRaw,
            deltaInputRaw,
            startOutputRaw,
            endOutputRaw,
            deltaOutputRaw,
          } = update.flush;

          if (this.debug) {
            this.log('[grid_counters] Flushing accumulated deltas', {
              durationMinutes,
              deltaInputRaw,
              deltaOutputRaw,
              divisorRawPerKwh,
            });
          }

          const duration = Math.max(0, durationMinutes);
          const importKwh = deltaInputRaw / divisorRawPerKwh;
          const exportKwh = deltaOutputRaw / divisorRawPerKwh;

          const settings = {
            debug: this.getSetting('statistics_debug'),
            transparency: this.getSetting('statistics_transparency'),
          };

          if (importKwh > 0) {
            const entry: StatisticsEntry = {
              timestamp: endTimestampSec,
              type: 'charging',
              energyAmount: importKwh, // Positive for charging
              duration,
              priceAtTime: price,
              startEnergyMeter: startInputRaw,
              endEnergyMeter: endInputRaw,
              calculationAudit: {
                precisionLoss: 0,
                validationWarnings: [],
                calculationMethod: 'grid_counters_import',
                isOutlier: false,
                recoveryActions: [],
              },
            };

            if (this.debug) {
              const profitSavingsResult = calculateProfitSavings(entry);
              this.log('[P&L] Calculated P&L value for charging:', profitSavingsResult.profitSavings, '€');
            }

            logStatisticsEntry(entry, settings, this.log.bind(this), {
              method: 'grid_counters_import',
              inputs: {
                startTs: startTimestampSec,
                endTs: endTimestampSec,
                startRaw: startInputRaw,
                endRaw: endInputRaw,
                deltaRaw: deltaInputRaw,
                divisorRawPerKwh,
              },
            });

            await this.logStatisticsEntry(entry);
          }

          if (exportKwh > 0) {
            const entry: StatisticsEntry = {
              timestamp: endTimestampSec,
              type: 'discharging',
              energyAmount: -exportKwh, // Negative for discharging
              duration,
              priceAtTime: price,
              startEnergyMeter: startOutputRaw,
              endEnergyMeter: endOutputRaw,
              calculationAudit: {
                precisionLoss: 0,
                validationWarnings: [],
                calculationMethod: 'grid_counters_export',
                isOutlier: false,
                recoveryActions: [],
              },
            };

            if (this.debug) {
              const profitSavingsResult = calculateProfitSavings(entry);
              this.log('[P&L] Calculated P&L value for discharging:', profitSavingsResult.profitSavings, '€');
            }

            logStatisticsEntry(entry, settings, this.log.bind(this), {
              method: 'grid_counters_export',
              inputs: {
                startTs: startTimestampSec,
                endTs: endTimestampSec,
                startRaw: startOutputRaw,
                endRaw: endOutputRaw,
                deltaRaw: deltaOutputRaw,
                divisorRawPerKwh,
              },
            });

            await this.logStatisticsEntry(entry);
          }
        }

        await this.setStoreValue(MarstekVenusDevice.GRID_COUNTER_ACCUMULATOR_STORE_KEY, update.state);
      } finally {
        // Release lock
        this.statisticsLock = false;
      }
    }

    /**
     * Memory-optimized verification report generation
     * Replaces inefficient string concatenation with single-pass processing
     * @param timePeriod Time period to verify (last_hour, last_day, last_week, last_month)
     * @param includeDetails Whether to include detailed breakdown
     * @returns Optimized verification report
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

      // Pre-allocate report sections to avoid repeated string concatenation
      const reportSections: string[] = [];
      reportSections.push(`Enhanced Verification Report for ${timePeriod.replace('_', ' ').toUpperCase()}`);
      reportSections.push(`Total entries: ${auditTrail.length}`);
      reportSections.push(''); // Empty line

      let validEntries = 0;
      let invalidEntries = 0;
      let precisionLosses = 0;
      let outliers = 0;
      let recoveryActions = 0;

      // Single-pass processing to minimize memory allocations
      for (let i = 0; i < auditTrail.length; i++) {
        const item = auditTrail[i];
        const isValid = item.verification.energyValid && item.verification.profitValid && item.verification.timestampValid;
        if (isValid) {
          validEntries++;
        } else {
          invalidEntries++;
        }

        if (item.verification.precisionLoss > 0) {
          precisionLosses++;
        }

        if (item.verification.outlierDetected) {
          outliers++;
        }

        if (item.verification.recoveryActions.length > 0) {
          recoveryActions += item.verification.recoveryActions.length;
        }

        if (includeDetails) {
          reportSections.push(`Entry: ${item.verification.details}`);

          if (item.verification.recoveryActions.length > 0) {
            reportSections.push(`  Recovery Actions: ${item.verification.recoveryActions.join('; ')}`);
          }
        }
      }

      // Add summary statistics
      reportSections.push(`Valid entries: ${validEntries}`);
      reportSections.push(`Invalid entries: ${invalidEntries}`);
      reportSections.push(`Precision losses detected: ${precisionLosses}`);
      reportSections.push(`Outliers detected: ${outliers}`);
      reportSections.push(`Total recovery actions: ${recoveryActions}`);

      // Get overall statistics summary
      const periodStats = stats.filter((s) => s.timestamp >= startTime / 1000 && s.timestamp < now / 1000);
      if (periodStats.length > 0) {
        const summary = getStatisticsSummary(periodStats);
        reportSections.push('');
        reportSections.push('Period Summary:');
        reportSections.push(`  Total charge energy: ${summary.summary.totalChargeEnergy.toFixed(3)} kWh`);
        reportSections.push(`  Total discharge energy: ${summary.summary.totalDischargeEnergy.toFixed(3)} kWh`);
        reportSections.push(`  Total profit: €${summary.summary.totalProfit.toFixed(2)}`);
        reportSections.push(`  Total savings: €${summary.summary.totalSavings.toFixed(2)}`);
        reportSections.push(`  Average price: €${summary.summary.averagePrice.toFixed(4)}/kWh`);
      }

      // Add status summary
      if (invalidEntries > 0 || precisionLosses > 0 || outliers > 0) {
        reportSections.push('');
        reportSections.push('⚠️  Issues detected:');
        if (invalidEntries > 0) {
          reportSections.push(`- ${invalidEntries} entries have validation failures`);
        }
        if (precisionLosses > 0) {
          reportSections.push(`- ${precisionLosses} entries have precision loss issues`);
        }
        if (outliers > 0) {
          reportSections.push(`- ${outliers} entries are statistical outliers`);
        }
        reportSections.push('Check logs for detailed information.');
      } else {
        reportSections.push('');
        reportSections.push('✅ All entries passed validation with no critical issues detected.');
      }

      // Single join operation instead of multiple concatenations
      return reportSections.join('\n');
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
     * Get the current energy price from settings with validation
     * @returns {number} Current energy price in €/kWh
     */
    getCurrentEnergyPrice(): number {
      const rawPrice = this.getSetting('price_per_kwh');
      const price = rawPrice != null ? Number(rawPrice) : 0.30;

      if (this.debug) this.log('[price_debug] Raw price from settings:', rawPrice, 'Converted to:', price);

      // Validate the price using our enhanced validation
      const validation = validateEnergyPriceUtil(price);

      if (!validation.isValid) {
        this.error(`Invalid energy price from settings: ${validation.error}. Using fallback price of €0.30/kWh`);
        return 0.30;
      }

      if (validation.warnings && validation.warnings.length > 0) {
        this.log(`Energy price warnings: ${validation.warnings.join('; ')}`);
      }

      this.log('Using validated energy price from settings:', price, '€/kWh');
      if (this.debug) this.log('[P&L] Applied price type check: typeof =', typeof price, ', isFinite =', Number.isFinite(price));
      return price;
    }

    /**
     * Log a statistics entry
     * @param entry The statistics entry to log
     */
    async logStatisticsEntry(entry: StatisticsEntry) {
      // Wait for lock to be released if another operation is in progress
      while (this.statisticsLock) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Acquire lock
      this.statisticsLock = true;

      try {
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
          calculationMethod: entry.calculationAudit!.calculationMethod,
        };

        await this.homey.flow.getTriggerCard('statistics_entry_logged').trigger({
          timestamp: entry.timestamp,
          value: Math.abs(entry.energyAmount),
          calculation_details: JSON.stringify(calculationDetails),
          energy_price: entry.priceAtTime || 0,
          calculation_method: entry.calculationAudit!.calculationMethod,
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
          calculation_method: entry.calculationAudit!.calculationMethod,
        }, {
          calculationType: entry.type === 'charging' ? 'charge' : 'discharge',
        });
      } finally {
        // Release lock
        this.statisticsLock = false;
      }
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
      this.log('[P&L] Daily profit:', dailyProfit, '€');
      await this.setCapabilityValue('measure_battery_profit_daily', dailyProfit);

      // Hourly profit: total daily profit divided by hours elapsed in the day
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const hoursElapsed = (now.getTime() - startOfDay.getTime()) / (1000 * 60 * 60);
      const hourlyProfit = (hoursElapsed > 0) ? dailyProfit / hoursElapsed : 0;
      this.log('[P&L] Hourly profit:', hourlyProfit, '€/h');
      await this.setCapabilityValue('measure_battery_profit_hourly', hourlyProfit);

      // Update detailed breakdown capabilities
      const breakdown = calculateDetailedBreakdown(stats);

      if (this.debug || this.getSetting('statistics_transparency') || this.getSetting('show_calculation_details')) {
        this.log('[P&L] Detailed breakdown: charge_energy=', breakdown.chargeEnergy, 'kWh, discharge_energy=', breakdown.dischargeEnergy, 'kWh, savings=', breakdown.savings, '€, cost=', breakdown.cost, '€, net_profit=', breakdown.netProfit, '€');
      }

      await this.setCapabilityValue('measure_battery_charge_energy_daily', breakdown.chargeEnergy);
      await this.setCapabilityValue('measure_battery_discharge_energy_daily', breakdown.dischargeEnergy);
      await this.setCapabilityValue('measure_battery_savings_daily', breakdown.savings);
      await this.setCapabilityValue('measure_battery_cost_daily', breakdown.cost);
      await this.setCapabilityValue('measure_battery_net_profit_daily', breakdown.netProfit);

      // Update real-time calculation display capabilities
      const currentPrice = this.getCurrentEnergyPrice();
      await this.setCapabilityValue('measure_current_energy_price', currentPrice);
      await this.setCapabilityValue('measure_calculation_method', 'hybrid');
      await this.setCapabilityValue('measure_calculation_timestamp', Math.floor(Date.now() / 1000));
      if (this.debug) this.log('[P&L] Aggregation outputs updated: daily_profit=', dailyProfit, ', charge_energy=', breakdown.chargeEnergy, ', discharge_energy=', breakdown.dischargeEnergy, ', savings=', breakdown.savings, ', cost=', breakdown.cost, ', net_profit=', breakdown.netProfit);
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
