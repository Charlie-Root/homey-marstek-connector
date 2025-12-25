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

    // Flow trigger state tracking
    private lastSocValue: number | null = null;
    private lastChargingState: string | null = null;
    private lastGridPowerDirection: 'import' | 'export' | 'idle' | null = null;
    private lastPvPowerValue: number | null = null;
    private lastTemperatureValue: number | null = null;
    private lastCtState: number | null = null;
    private lastMode: string | null = null;

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

      // Register listeners for P&L capabilities to ensure UI updates
      await this.registerCapabilityListener('measure_battery_profit_daily', this.onCapabilityProfitDaily.bind(this));
      await this.registerCapabilityListener('measure_battery_profit_hourly', this.onCapabilityProfitHourly.bind(this));
      await this.registerCapabilityListener('measure_battery_charge_energy_daily', this.onCapabilityChargeEnergyDaily.bind(this));
      await this.registerCapabilityListener('measure_battery_discharge_energy_daily', this.onCapabilityDischargeEnergyDaily.bind(this));
      await this.registerCapabilityListener('measure_battery_savings_daily', this.onCapabilitySavingsDaily.bind(this));
      await this.registerCapabilityListener('measure_battery_cost_daily', this.onCapabilityCostDaily.bind(this));
      await this.registerCapabilityListener('measure_battery_net_profit_daily', this.onCapabilityNetProfitDaily.bind(this));
      await this.registerCapabilityListener('measure_calculation_timestamp', this.onCapabilityCalculationTimestamp.bind(this));
      await this.registerCapabilityListener('measure_current_energy_price', this.onCapabilityEnergyPrice.bind(this));
      await this.registerCapabilityListener('measure_calculation_method', this.onCapabilityCalculationMethod.bind(this));

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
           firmware = Number(String(this.getSetting('firmware')).replace(/\./g, ''));
        } else {
           const model = this.getSetting('model');
           if (model) {
             const versionPart = model.split(' v')[1];
             if (versionPart) {
               firmware = Number(versionPart.replace(/\./g, ''));
             }
           }
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
          if (!isNaN(result.bat_capacity)) {
            const batDivisor = (firmware >= 154) ? 1000.0 : 1000.0;
            const batteryKwh = result.bat_capacity / batDivisor;
            await this.setCapabilityValue('meter_power', batteryKwh);
            if (this.debug && this.getSetting('statistics_debug')) {
              this.log(`[P&L] DEBUG: Battery capacity raw=${result.bat_capacity}, divisor=${batDivisor}, calculated kWh=${batteryKwh}`);
            }
          }

          // Battery state of charge
          if (!isNaN(result.bat_soc)) await this.setCapabilityValue('measure_battery', result.bat_soc);

          // Battery power and charging state
          if (!isNaN(result.bat_power)) {
            // Charge state (Possible values: "idle", "charging", "discharging")
            if (this.debug) this.log('[stats] Battery power:', result.bat_power);
            try {
              const state = (result.bat_power > 0) ? 'charging' : (result.bat_power < 0) ? 'discharging' : 'idle';
              if (this.debug) this.log('[stats] Setting battery_charging_state from bat_power:', result.bat_power, '=>', state);
              await this.setCapabilityValue('battery_charging_state', state);
              if (this.debug) {
                const cur = await this.getCapabilityValue('battery_charging_state');
                this.log('[stats] battery_charging_state after set (bat_power):', cur);
              }
            } catch (err) {
              this.error('[stats] Failed to set battery_charging_state from bat_power:', err);
            }
            await this.setCapabilityValue('measure_power', result.bat_power / ((firmware >= 154) ? 1.0 : 10.0));

            // Auto-detect ongrid_power sign convention when both values are present.
            try {
              if (!isNaN(result.ongrid_power)) {
                if (result.bat_power < 0 && result.ongrid_power > 0) {
                  await this.setStoreValue('ongrid_positive_exports', true);
                  if (this.debug && this.getSetting('statistics_debug')) this.log('[stats] Detected ongrid_positive_exports = true');
                } else if (result.bat_power > 0 && result.ongrid_power < 0) {
                  await this.setStoreValue('ongrid_positive_exports', false);
                  if (this.debug && this.getSetting('statistics_debug')) this.log('[stats] Detected ongrid_positive_exports = false');
                }
              }
            } catch (err) {
              if (this.debug) this.error('[stats] Failed to persist ongrid sign detection:', err);
            }

          } else {
            if (this.debug) {
              this.log('[stats] Battery power not available');
            }
            if (!isNaN(result.ongrid_power)) {
              try {
                // Read persisted detection flag (true = positive means export/discharging)
                const ongridPositiveExports: boolean | null = this.getStoreValue('ongrid_positive_exports') ?? null;
                let state: 'charging' | 'discharging' | 'idle';
                if (ongridPositiveExports === null) {
                  // Unknown convention, fall back to heuristics: assume positive => export/discharging
                  state = (result.ongrid_power > 0) ? 'discharging' : (result.ongrid_power < 0) ? 'charging' : 'idle';
                } else if (ongridPositiveExports === true) {
                  // Positive ongrid_power means export (battery discharging)
                  state = (result.ongrid_power > 0) ? 'discharging' : (result.ongrid_power < 0) ? 'charging' : 'idle';
                } else {
                  // Positive ongrid_power means import (battery charging)
                  state = (result.ongrid_power > 0) ? 'charging' : (result.ongrid_power < 0) ? 'discharging' : 'idle';
                }

                if (this.debug) this.log('[stats] Setting battery_charging_state from ongrid_power:', result.ongrid_power, '=>', state, '(ongridPositiveExports=', ongridPositiveExports, ')');
                await this.setCapabilityValue('battery_charging_state', state);
                if (this.debug) {
                  const cur = await this.getCapabilityValue('battery_charging_state');
                  this.log('[stats] battery_charging_state after set (ongrid_power):', cur);
                }

                // Also set measure_power so Homey Energy shows correct sign (positive=charging)
                try {
                  let measurePowerVal = 0;
                  if (ongridPositiveExports === null) {
                    // heuristic: positive ongrid => export => battery discharging => measure_power negative
                    measurePowerVal = (result.ongrid_power > 0) ? -Math.abs(result.ongrid_power) : (result.ongrid_power < 0) ? Math.abs(result.ongrid_power) : 0;
                  } else if (ongridPositiveExports === true) {
                    // positive => export => battery discharging
                    measurePowerVal = (result.ongrid_power > 0) ? -Math.abs(result.ongrid_power) : (result.ongrid_power < 0) ? Math.abs(result.ongrid_power) : 0;
                  } else {
                    // positive => import => battery charging
                    measurePowerVal = (result.ongrid_power > 0) ? Math.abs(result.ongrid_power) : (result.ongrid_power < 0) ? -Math.abs(result.ongrid_power) : 0;
                  }
                  await this.setCapabilityValue('measure_power', measurePowerVal / ((firmware >= 154) ? 1.0 : 10.0));
                  if (this.debug && this.getSetting('statistics_debug')) this.log('[stats] measure_power set from ongrid_power to', measurePowerVal);
                } catch (err) {
                  if (this.debug) this.error('[stats] Failed to set measure_power from ongrid_power:', err);
                }
              } catch (err) {
                this.error('[stats] Failed to set battery_charging_state from ongrid_power:', err);
              }
            }
          }

          // Input and output energy (kWh)
          // CRITICAL FIX: Correct divisor calculation based on actual device behavior
          // The original logic was incorrect - firmware >= 154 should use 1000, but
          // firmware < 154 should use 10, not 100
          const divisor = (firmware >= 154) ? 100.0 : 1000.0;
          if (this.debug) this.log('Firmware:', firmware, 'divisor:', divisor);
          // CRITICAL DEBUG: Log divisor calculation details
          if (this.debug && this.getSetting('statistics_debug')) {
            this.log(`[P&L] CRITICAL: Divisor calculation - firmware=${firmware}, divisor=${divisor}`);
            this.log(`[P&L] CRITICAL: Fixed divisor calculation - now using ${divisor} instead of 100`);
            this.log(`[P&L] DEBUG: Raw input_energy=${result.total_grid_input_energy ?? result.input_energy}, raw output_energy=${result.total_grid_output_energy ?? result.output_energy}`);
          }
          // Handle input energy (try multiple field names)
          const inputEnergyRaw = result.total_grid_input_energy ?? result.input_energy;
          if (!isNaN(inputEnergyRaw)) {
            if (this.debug) this.log('Raw input_energy:', inputEnergyRaw);
            const value = inputEnergyRaw / divisor;
            await this.setCapabilityValue('meter_power.imported', value);
            if (this.debug) this.log('Setting meter_power.imported to:', value, 'from raw:', inputEnergyRaw, 'divisor:', divisor);
          }
          
          // Handle output energy (try multiple field names)
          const outputEnergyRaw = result.total_grid_output_energy ?? result.output_energy;
          if (!isNaN(outputEnergyRaw)) {
            if (this.debug) this.log('Raw output_energy:', outputEnergyRaw);
            const value = outputEnergyRaw / divisor;
            await this.setCapabilityValue('meter_power.exported', value);
            if (this.debug) this.log('Setting meter_power.exported to:', value, 'from raw:', outputEnergyRaw, 'divisor:', divisor);
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
              // Check for mode change trigger
              await this.checkAndTriggerModeChange(mode);
            }
          }

          // EM status
          if (result.ct_state !== undefined) {
            const currentCtState = await this.getCapabilityValue('measure_ct_state');
            const newCtState = result.ct_state.toString();
            if (currentCtState !== newCtState) {
              await this.setCapabilityValue('measure_ct_state', newCtState);
              // Trigger existing flow
              await this.homey.flow.getTriggerCard('marstek_ct_state_changed').trigger({ state: result.ct_state });
              // Trigger CT disconnected flow when state becomes 0 (disconnected)
              if (result.ct_state === 0 && this.lastCtState !== 0) {
                await this.homey.flow.getTriggerCard('marstek_ct_disconnected').trigger({
                  ct_state: result.ct_state,
                  previous_state: this.lastCtState
                });
              }
            }
            this.lastCtState = result.ct_state;
          }

          // Flow trigger logic for battery state changes
          await this.checkAndTriggerBatteryFlows(result);
          if (!isNaN(result.a_power)) await this.setCapabilityValue('measure_power.a', result.a_power);
          if (!isNaN(result.b_power)) await this.setCapabilityValue('measure_power.b', result.b_power);
          if (!isNaN(result.c_power)) await this.setCapabilityValue('measure_power.c', result.c_power);
          if (!isNaN(result.total_power)) await this.setCapabilityValue('measure_power.total', result.total_power);

          // Statistics/profit calculation: try grid counter first, fallback to power-based
          if (this.getSetting('enable_statistics')) {
            if (this.debug) this.log('[P&L] Statistics enabled, attempting grid counter statistics first');
            try {
              await this.processGridCounterStatistics(result, 1000.0); // Use divisor 10 for firmware < 154
              if (this.debug) this.log('[P&L] Grid counter statistics processing completed successfully');
            } catch (error) {
              if (this.debug) this.error('[P&L] Grid counter statistics failed, falling back to power-based:', error);
              try {
                await this.processPowerBasedStatistics(result);
                if (this.debug) this.log('[P&L] Power-based statistics processing completed successfully');
              } catch (powerError) {
                if (this.debug) this.error('[P&L] Power-based statistics also failed:', powerError);
              }
            }
          } else {
            if (this.debug) this.log('[P&L] Statistics disabled, skipping statistics processing');
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
       if (this.debug) this.log('[P&L] processGridCounterStatistics called with divisor:', divisorRawPerKwh);
       if (this.debug) this.log('enable_statistics is enabled, processing grid counter statistics');
      // DEBUG: Log current grid counter values for troubleshooting
      if (this.debug && this.getSetting('statistics_debug')) {
        this.log(`[P&L] Current grid counters: input=${result.total_grid_input_energy}, output=${result.total_grid_output_energy}, divisor=${divisorRawPerKwh}`);
        // CRITICAL DEBUG: Log the divisor calculation logic
        const firmware = this.getSetting('firmware');
        let calculatedDivisor = 100.0;
        if (firmware) {
          const version = Number(String(firmware).replace(/\./g, ''));
          calculatedDivisor = (version >= 154) ? 1000.0 : 100.0;
        }
        this.log(`[P&L] CRITICAL: Firmware divisor calculation - firmware=${firmware}, version=${firmware ? Number(String(firmware).replace(/\./g, '')) : 'unknown'}, calculatedDivisor=${calculatedDivisor}, divisorRawPerKwh=${divisorRawPerKwh}`);
      }

      // DEBUG: Check if counters are static (no energy flow)
      const storedState: GridCounterAccumulatorState | null = this.getStoreValue(MarstekVenusDevice.GRID_COUNTER_ACCUMULATOR_STORE_KEY) || null;
      if (storedState && this.debug && this.getSetting('statistics_debug')) {
        // Try to get grid counters from available fields
        const currentInputRaw = Number(result.total_grid_input_energy ?? result.input_energy ?? 0);
        const currentOutputRaw = Number(result.total_grid_output_energy ?? result.output_energy ?? 0);
        
        // Log which fields we're using for debugging
        if (this.debug && this.getSetting('statistics_debug')) {
          this.log(`[P&L] Using grid counter fields: total_grid_input_energy=${result.total_grid_input_energy}, input_energy=${result.input_energy}, total_grid_output_energy=${result.total_grid_output_energy}, output_energy=${result.output_energy}`);
          this.log(`[P&L] Final values: currentInputRaw=${currentInputRaw}, currentOutputRaw=${currentOutputRaw}`);
        }
        const deltaInput = currentInputRaw - storedState.lastInputRaw;
        const deltaOutput = currentOutputRaw - storedState.lastOutputRaw;
        if (deltaInput === 0 && deltaOutput === 0) {
          if (this.debug) {
            this.log(`[P&L] WARNING: Grid counters are static - no energy flow detected. Input: ${currentInputRaw}, Output: ${currentOutputRaw}`);
          }
        } else {
          if (this.debug) {
            this.log(`[P&L] Energy flow detected: input_delta=${deltaInput}, output_delta=${deltaOutput}`);
          }
        }
      }

      // CRITICAL FIX: Use the corrected divisor calculation for grid counter statistics
      // This must match the divisor used for capability updates
      // Get firmware version for correct divisor calculation
      let firmware = 0;
      if (this.getSetting('firmware')) {
         firmware = Number(String(this.getSetting('firmware')).replace(/\./g, ''));
      } else {
         const model = this.getSetting('model');
         if (model) {
           const versionPart = model.split(' v')[1];
           if (versionPart) {
             firmware = Number(versionPart.replace(/\./g, ''));
           }
         }
      }

      const correctedDivisorRawPerKwh = (firmware >= 154) ? 1000.0 : 1000.0;
      if (this.debug && this.getSetting('statistics_debug')) {
        this.log(`[P&L] CRITICAL: Using corrected divisorRawPerKwh=${correctedDivisorRawPerKwh} for grid counter statistics (firmware=${firmware})`);
        this.log(`[P&L] DEBUG: Firmware=${firmware}, correctedDivisorRawPerKwh=${correctedDivisorRawPerKwh}`);
      }

      // Wait for lock to be released if another operation is in progress
      while (this.statisticsLock) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

  // Acquire lock
  this.statisticsLock = true;

  // Prepare an array to collect entries that must be persisted after the lock is released
  const pendingEntries: StatisticsEntry[] = [];

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
            if (this.debug) {
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
          }
          if (deltaOutputRaw >= 0) {
            if (this.debug) {
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
        }

        const update = updateGridCounterAccumulator(storedState, {
          timestampSec: nowSec,
          inputRaw: currentInputRaw,
          outputRaw: currentOutputRaw,
          divisorRawPerKwh: correctedDivisorRawPerKwh, // Use corrected divisor
        }, {
          flushIntervalMinutes: 15, // Reduced from 60 to 15 minutes for faster calculation triggers
          minDeltaTriggerRaw: 5, // New: minimum delta to trigger immediate flush (5 raw units)
        });
        
        // CRITICAL DEBUG: Log the divisor being used in accumulator
        if (this.debug && this.getSetting('statistics_debug')) {
          this.log(`[P&L] CRITICAL: Using correctedDivisorRawPerKwh=${correctedDivisorRawPerKwh} in accumulator. This should fix the 10x error!`);
        }
        // DEBUG: Log accumulator update result
        if (this.debug && this.getSetting('statistics_debug')) {
          this.log(`[P&L] Accumulator update: reason=${update.reason}, hasFlush=${!!update.flush}, accInputDelta=${update.state.accInputDeltaRaw}, accOutputDelta=${update.state.accOutputDeltaRaw}`);
        }

        // Enhanced logging for flush triggers and reasons
        if (update.reason && update.reason !== 'no_flush') {
          if (this.debug && this.getSetting('statistics_debug')) {
            this.log('[grid_counters] accumulator update:', update.reason);
          }

          // Log flush trigger details
          if (update.flush) {
            const flushDetails = {
              reason: update.reason,
              durationMinutes: update.flush.durationMinutes,
              inputDeltaRaw: update.flush.deltaInputRaw,
              outputDeltaRaw: update.flush.deltaOutputRaw,
              divisorRawPerKwh: update.flush.divisorRawPerKwh,
              inputDeltaKwh: update.flush.deltaInputRaw / update.flush.divisorRawPerKwh,
              outputDeltaKwh: update.flush.deltaOutputRaw / update.flush.divisorRawPerKwh,
              timestamp: new Date(update.flush.endTimestampSec * 1000).toISOString()
            };

            if (this.debug && this.getSetting('statistics_debug')) {
              this.log(`[P&L] FLUSH TRIGGERED: ${update.reason.toUpperCase()}`);
              this.log(`[P&L] Flush details:`, JSON.stringify(flushDetails, null, 2));

              // Log specific trigger conditions
              if (update.reason === 'delta_trigger') {
                this.log(`[P&L] Delta trigger activated: input=${update.flush.deltaInputRaw}, output=${update.flush.deltaOutputRaw}, minDelta=5`);
              } else if (update.reason === 'time_interval') {
                this.log(`[P&L] Time interval trigger activated: duration=${update.flush.durationMinutes}min, threshold=15min`);
              } else if (update.reason === 'utc_day_boundary') {
                this.log(`[P&L] UTC day boundary trigger activated`);
              }
            }
          }
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

          if (this.debug && this.getSetting('statistics_debug')) {
            this.log('[grid_counters] Flushing accumulated deltas', {
              durationMinutes,
              deltaInputRaw,
              deltaOutputRaw,
              divisorRawPerKwh,
            });
          }

          const duration = Math.max(0, durationMinutes);

          // Sanity-check divisor: different firmwares/reporting may use divisors 10, 100 or 1000.
          // If computed kWh is implausibly large, try alternate divisors and pick the most plausible.
          const batteryCapacityKwh = Number(this.getSetting('battery_capacity_kwh')) || null; // optional hint from user
          if (this.debug && this.getSetting('statistics_debug')) {
            this.log(`[P&L] DEBUG: batteryCapacityKwh=${batteryCapacityKwh}`);
          }

          const computeKwh = (raw: number, divisor: number) => raw / divisor;

          const isImplausible = (kwh: number) => {
            if (!Number.isFinite(kwh)) return true;
            if (kwh < 0) return true;
            if (batteryCapacityKwh && kwh > (batteryCapacityKwh * 2)) return true; // more than twice battery capacity in one flush
            // Reduce default absolute threshold to catch cases where a wrong divisor yields a 10x inflated value
            if (!batteryCapacityKwh && kwh > 10) return true; // default absolute threshold (reduced)
            return false;
          };

          let usedDivisor = correctedDivisorRawPerKwh;
          let importKwh = computeKwh(deltaInputRaw, usedDivisor);
          let exportKwh = computeKwh(deltaOutputRaw, usedDivisor);

          // CRITICAL DEBUG: Log the initial calculation before divisor adjustment
          if (this.debug && this.getSetting('statistics_debug')) {
            this.log(`[P&L] CRITICAL: Initial calculation - correctedDivisor=${usedDivisor}, importKwh=${importKwh}, exportKwh=${exportKwh}, deltaInputRaw=${deltaInputRaw}, deltaOutputRaw=${deltaOutputRaw}`);
          }

          if ((importKwh > 0 && isImplausible(importKwh)) || (exportKwh > 0 && isImplausible(exportKwh))) {
            const candidateDivisors = [10, 100, 1000];
            if (!candidateDivisors.includes(usedDivisor)) candidateDivisors.unshift(usedDivisor);

            if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Implausible energy detected, trying alternate divisors', {
              initialDivisor: usedDivisor,
              importKwh,
              exportKwh,
              batteryCapacityKwh,
            });

            let found = false;
            for (const d of candidateDivisors) {
              const trialImport = computeKwh(deltaInputRaw, d);
              const trialExport = computeKwh(deltaOutputRaw, d);
              if ((trialImport === 0 || !isImplausible(trialImport)) && (trialExport === 0 || !isImplausible(trialExport))) {
                usedDivisor = d;
                importKwh = trialImport;
                exportKwh = trialExport;
                found = true;
                if (this.debug && this.getSetting('statistics_debug')) {
                  this.log('[P&L] Selected alternate divisor', d, 'importKwh', importKwh, 'exportKwh', exportKwh);
                  if (d === 10) {
                    this.log('[P&L] CRITICAL: Using divisor 10 - this should fix the 10x error!');
                  }
                }
                break;
              }
            }

            if (!found) {
              if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] No plausible alternate divisor found; keeping original divisor', usedDivisor);
            }
          }

          // DEBUG: Log final used divisor and kWh
          if (this.debug && this.getSetting('statistics_debug')) {
            this.log(`[P&L] DEBUG: Final usedDivisor=${usedDivisor}, final importKwh=${importKwh}, final exportKwh=${exportKwh}`);
          }

          const settings = {
            debug: this.getSetting('statistics_debug'),
            transparency: this.getSetting('statistics_transparency'),
          };

          if (importKwh > 0) {
            // Compute time-weighted price across the flushed interval
            const weightedPrice = this.computeTimeWeightedPrice(startTimestampSec, endTimestampSec, price);
            if (this.debug && this.getSetting('statistics_debug')) {
              this.log('[P&L] Using weighted price for charging entry:', weightedPrice, ' (fallback:', price, ')');
            }

            const entry: StatisticsEntry = {
              timestamp: endTimestampSec,
              type: 'charging',
              energyAmount: importKwh, // Positive for charging
              duration,
              priceAtTime: weightedPrice,
              startEnergyMeter: startInputRaw,
              endEnergyMeter: endInputRaw,
              calculationAudit: {
                precisionLoss: 0,
                validationWarnings: [],
                calculationMethod: 'grid_counters_import_time_weighted',
                isOutlier: false,
                recoveryActions: (usedDivisor !== divisorRawPerKwh) ? [`divisor_adjusted:${usedDivisor}`] : [],
              },
            };

            if (this.debug && this.getSetting('statistics_debug')) {
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
            // Defer the device-local persistent logging until after we release the statisticsLock
            pendingEntries.push(entry);
          }

          if (exportKwh > 0) {
            // Compute time-weighted price across the flushed interval
            const weightedPrice = this.computeTimeWeightedPrice(startTimestampSec, endTimestampSec, price);
            if (this.debug && this.getSetting('statistics_debug')) {
              this.log('[P&L] Using weighted price for discharging entry:', weightedPrice, ' (fallback:', price, ')');
            }

            const entry: StatisticsEntry = {
              timestamp: endTimestampSec,
              type: 'discharging',
              energyAmount: -exportKwh, // Negative for discharging
              duration,
              priceAtTime: weightedPrice,
              startEnergyMeter: startOutputRaw,
              endEnergyMeter: endOutputRaw,
              calculationAudit: {
                precisionLoss: 0,
                validationWarnings: [],
                calculationMethod: 'grid_counters_export_time_weighted',
                isOutlier: false,
                recoveryActions: (usedDivisor !== divisorRawPerKwh) ? [`divisor_adjusted:${usedDivisor}`] : [],
              },
            };

            if (this.debug && this.getSetting('statistics_debug')) {
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
            // Defer the device-local persistent logging until after we release the statisticsLock
            pendingEntries.push(entry);
          }
        }

        
        // DEBUG: Log final accumulator state
        if (this.debug && this.getSetting('statistics_debug')) {
          const finalState = update.state;
          this.log(`[P&L] Final accumulator state: duration=${(nowSec - finalState.accStartTimestampSec) / 60}min, accInputDelta=${finalState.accInputDeltaRaw}, accOutputDelta=${finalState.accOutputDeltaRaw}`);
        }

        await this.setStoreValue(MarstekVenusDevice.GRID_COUNTER_ACCUMULATOR_STORE_KEY, update.state);
      } finally {
        // Release lock
        this.statisticsLock = false;
      }

      // Process any deferred/pending entries now that the lock is released
      try {
        if (pendingEntries.length > 0) {
          if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Processing deferred statistics entries:', pendingEntries.length);
          for (const e of pendingEntries) {
            // This method acquires its own lock internally and persists the statistics store
            await this.logStatisticsEntry(e);
          }
        }

        // After successfully processing and saving statistics entries, update the profit capabilities
        if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] CRITICAL: About to call updateProfitCapabilities() - this should be visible in logs');
        await this.updateProfitCapabilities();
        if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] CRITICAL: updateProfitCapabilities() completed successfully');
      } catch (err) {
        this.error('[P&L] Error while processing deferred statistics entries or updating capabilities:', err);
      }
    }

    /**
     * Process statistics using real-time power data since device lacks cumulative energy counters.
     * This method accumulates energy over time using power measurements.
     * @param result The API response result containing power data
     */
    private async processPowerBasedStatistics(result: any): Promise<void> {
        if (this.debug) this.log('enable_statistics is enabled, processing power-based statistics');
        
        // DEBUG: Log that we're using power-based calculation
        if (this.debug && this.getSetting('statistics_debug')) {
          this.log(`[P&L] CRITICAL: Using power-based statistics calculation (device lacks cumulative counters)`);
          this.log(`[P&L] Power values: bat_power=${result.bat_power}, ongrid_power=${result.ongrid_power}`);
        }
  
        // Wait for lock to be released if another operation is in progress
        while (this.statisticsLock) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
  
        // Acquire lock
        this.statisticsLock = true;
  
        try {
          const now = new Date();
          const nowSec = Math.floor(now.getTime() / 1000);
  
          // Get current battery power (in watts)
          let currentPower = 0;
          if (!isNaN(result.bat_power)) {
            currentPower = result.bat_power / ((this.getSetting('firmware') >= 154) ? 1.0 : 10.0);
          } else if (!isNaN(result.ongrid_power)) {
            // Use ongrid power as fallback, but need to determine sign convention
            const ongridPositiveExports: boolean | null = this.getStoreValue('ongrid_positive_exports') ?? null;
            let powerValue = result.ongrid_power;
            
            if (ongridPositiveExports === null) {
              // heuristic: assume positive ongrid => export => battery discharging
              currentPower = (powerValue > 0) ? -Math.abs(powerValue) : (powerValue < 0) ? Math.abs(powerValue) : 0;
            } else if (ongridPositiveExports === true) {
              // positive => export => battery discharging
              currentPower = (powerValue > 0) ? -Math.abs(powerValue) : (powerValue < 0) ? Math.abs(powerValue) : 0;
            } else {
              // positive => import => battery charging
              currentPower = (powerValue > 0) ? Math.abs(powerValue) : (powerValue < 0) ? -Math.abs(powerValue) : 0;
            }
          }
  
          if (this.debug && this.getSetting('statistics_debug')) {
            this.log(`[P&L] Current power calculated: ${currentPower}W`);
          }
  
          // Get stored state for power-based accumulation
          const powerAccumulatorKey = 'power_accumulator_state';
          let accumulatorState: any = this.getStoreValue(powerAccumulatorKey) || {
            lastTimestampSec: nowSec,
            lastPower: 0,
            accumulatedEnergy: 0
          };
  
          // Calculate energy accumulated since last update
          const timeDeltaSec = nowSec - accumulatorState.lastTimestampSec;

          if (this.debug && this.getSetting('statistics_debug')) {
            this.log(`[P&L] Power accumulation check: timeDelta=${timeDeltaSec}s, lastPower=${accumulatorState.lastPower}, currentPower=${currentPower}`);
          }

          if (timeDeltaSec > 0) {
            // Calculate average power during the interval
            // For first run, use current power; otherwise use average of last and current
            const avgPower = (accumulatorState.lastPower === 0) ? currentPower : (accumulatorState.lastPower + currentPower) / 2;

            // Calculate energy in watt-seconds (joules)
            const energyWs = avgPower * timeDeltaSec;

            // Convert to kWh (1 kWh = 3,600,000 Ws)
            const energyKwh = energyWs / 3600000;

            if (this.debug && this.getSetting('statistics_debug')) {
              this.log(`[P&L] Power accumulation: timeDelta=${timeDeltaSec}s, avgPower=${avgPower}W, energy=${energyKwh}kWh`);
            }
  
            // Create statistics entry based on energy flow direction
            if (Math.abs(energyKwh) > 0.000001 || timeDeltaSec > 300) { // Log if significant energy change OR if it's been 5+ minutes
              const entry: StatisticsEntry = {
                timestamp: nowSec,
                type: energyKwh > 0 ? 'charging' : 'discharging',
                energyAmount: energyKwh, // Positive for charging, negative for discharging
                duration: timeDeltaSec / 60, // Convert to minutes
                priceAtTime: this.getCurrentEnergyPrice(),
                startEnergyMeter: undefined, // Not applicable for power-based calculation
                endEnergyMeter: undefined,   // Not applicable for power-based calculation
                calculationAudit: {
                  precisionLoss: 0,
                  validationWarnings: [],
                  calculationMethod: 'power_integration',
                  isOutlier: false,
                  recoveryActions: [],
                },
              };
  
              if (this.debug && this.getSetting('statistics_debug')) {
                const profitSavingsResult = calculateProfitSavings(entry);
                this.log(`[P&L] Power-based entry: ${entry.type}, energy=${entry.energyAmount}kWh, profit=${profitSavingsResult.profitSavings}€`);
              }
  
              // Log the entry
              await this.logStatisticsEntry(entry);
            }
          }
  
          // Update accumulator state
          accumulatorState.lastTimestampSec = nowSec;
          accumulatorState.lastPower = currentPower;
          
          // Clean up very old accumulator state (keep only last 24 hours)
          if (nowSec - accumulatorState.lastTimestampSec > 86400) {
            accumulatorState.lastTimestampSec = nowSec;
            accumulatorState.lastPower = 0;
          }
  
          await this.setStoreValue(powerAccumulatorKey, accumulatorState);
  
          // Update profit capabilities
          await this.updateProfitCapabilities();
  
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

      // Handle statistics reset checkbox
      if (event.changedKeys.includes('reset_statistics') && event.newSettings.reset_statistics === true) {
        // Perform the reset
        await this.resetStatistics();
        // Auto-uncheck the checkbox after reset
        this.homey.setTimeout(async () => {
          try {
            await this.setSettings({ reset_statistics: false });
          } catch (err) {
            this.error('Failed to uncheck reset_statistics setting:', err);
          }
        }, 100);
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
     * Handle measure_battery_profit_daily capability changes.
     * @param {number} value The new profit value
     */
    async onCapabilityProfitDaily(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Profit daily capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Profit daily capability listener triggered with value:', value);
    }

    /**
     * Handle measure_battery_profit_hourly capability changes.
     * @param {number} value The new hourly profit value
     */
    async onCapabilityProfitHourly(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Profit hourly capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Profit hourly capability listener triggered with value:', value);
    }

    /**
     * Handle measure_battery_charge_energy_daily capability changes.
     * @param {number} value The new charge energy value
     */
    async onCapabilityChargeEnergyDaily(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Charge energy daily capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Charge energy daily capability listener triggered with value:', value);
    }

    /**
     * Handle measure_battery_discharge_energy_daily capability changes.
     * @param {number} value The new discharge energy value
     */
    async onCapabilityDischargeEnergyDaily(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Discharge energy daily capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Discharge energy daily capability listener triggered with value:', value);
    }

    /**
     * Handle measure_battery_savings_daily capability changes.
     * @param {number} value The new savings value
     */
    async onCapabilitySavingsDaily(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Savings daily capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Savings daily capability listener triggered with value:', value);
    }

    /**
     * Handle measure_battery_cost_daily capability changes.
     * @param {number} value The new cost value
     */
    async onCapabilityCostDaily(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Cost daily capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Cost daily capability listener triggered with value:', value);
    }

    /**
     * Handle measure_battery_net_profit_daily capability changes.
     * @param {number} value The new net profit value
     */
    async onCapabilityNetProfitDaily(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Net profit daily capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Net profit daily capability listener triggered with value:', value);
    }

    /**
     * Handle measure_calculation_timestamp capability changes.
     * @param {number} value The new timestamp value
     */
    async onCapabilityCalculationTimestamp(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Calculation timestamp capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Calculation timestamp capability listener triggered with value:', value);
    }

    /**
     * Handle measure_current_energy_price capability changes.
     * @param {number} value The new energy price value
     */
    async onCapabilityEnergyPrice(value: number) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Energy price capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Energy price capability listener triggered with value:', value);
    }

    /**
     * Handle measure_calculation_method capability changes.
     * @param {string} value The new calculation method value
     */
    async onCapabilityCalculationMethod(value: string) {
      if (this.debug && this.getSetting('statistics_debug')) this.log('Calculation method capability updated to:', value);
      // This is a read-only capability, just log the update
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Calculation method capability listener triggered with value:', value);
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
        if (this.debug) {
          this.log(`Energy price warnings: ${validation.warnings.join('; ')}`);
        }
      }

      if (this.debug) {
        this.log('Using validated energy price from settings:', price, '€/kWh');
      }
      if (this.debug) {
        this.log('[P&L] Applied price type check: typeof =', typeof price, ', isFinite =', Number.isFinite(price));
      }
      // Record a price snapshot for time-weighted calculations (fire-and-forget)
      try {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.recordPriceSnapshot(price);
      } catch (e) {
        // ignore recording errors
      }

      return price;
    }

    /**
     * Record a timestamped price snapshot in the device store for later time-weighted calculations.
     * Keeps history trimmed to the last 72 hours to avoid growth.
     * This is best-effort and intentionally non-blocking when called from synchronous code.
     * @param price Price in €/kWh
     */
    async recordPriceSnapshot(price: number): Promise<void> {
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const key = 'price_history';
        const existing: Array<{ ts: number; price: number }> = this.getStoreValue(key) || [];

        // Only append if price changed or the last snapshot is older than 1 hour
        const last = existing.length > 0 ? existing[existing.length - 1] : undefined;
        if (last && last.price === price && (nowSec - last.ts) < 3600) {
          return; // nothing to do
        }

        existing.push({ ts: nowSec, price });

        // Trim snapshots older than 72 hours
        const cutoff = nowSec - (72 * 60 * 60);
        const trimmed = existing.filter((s) => s.ts >= cutoff);

        // Persist (do not await so callers remain synchronous)
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.setStoreValue(key, trimmed);
      } catch (err) {
        this.error('Failed to record price snapshot:', err);
      }
    }

    /**
     * Compute a time-weighted average price for an interval [startSec, endSec].
     * If no price history exists that covers the interval, returns fallbackPrice.
     * @param startSec start timestamp (seconds)
     * @param endSec end timestamp (seconds)
     * @param fallbackPrice fallback if computation not possible
     */
    computeTimeWeightedPrice(startSec: number, endSec: number, fallbackPrice: number): number {
      try {
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return fallbackPrice;

        const key = 'price_history';
        const history: Array<{ ts: number; price: number }> = this.getStoreValue(key) || [];
        if (!history || history.length === 0) return fallbackPrice;

        // Ensure sorted ascending
        const hist = [...history].sort((a, b) => a.ts - b.ts);

        // Find the price that applies at startSec: last snapshot with ts <= startSec
        let idx = -1;
        for (let i = 0; i < hist.length; i++) {
          if (hist[i].ts <= startSec) idx = i;
          else break;
        }

        // If no snapshot before start, use the first one as starting price (best-effort)
        if (idx === -1) idx = 0;

        let accPriceSeconds = 0;
        const totalSeconds = endSec - startSec;

        let segmentStart = startSec;
        for (let i = idx; i < hist.length && segmentStart < endSec; i++) {
          const segPrice = hist[i].price;
          const nextTs = (i + 1 < hist.length) ? hist[i + 1].ts : Infinity;
          const segEnd = Math.min(nextTs, endSec);
          if (segEnd > segmentStart) {
            const overlap = segEnd - segmentStart;
            accPriceSeconds += overlap * segPrice;
            segmentStart = segEnd;
          }
        }

        // If we didn't reach endSec (no later snapshots), use last known price to cover remaining period
        if (segmentStart < endSec) {
          const lastPrice = hist[hist.length - 1].price;
          accPriceSeconds += (endSec - segmentStart) * lastPrice;
          segmentStart = endSec;
        }

        if (totalSeconds <= 0) return fallbackPrice;

        const weighted = accPriceSeconds / totalSeconds;
        if (!Number.isFinite(weighted) || isNaN(weighted)) return fallbackPrice;

        return weighted;
      } catch (err) {
        this.error('Failed to compute time-weighted price:', err);
        return fallbackPrice;
      }
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
        
        // Log successful storage of statistics
        if (this.debug && this.getSetting('statistics_debug')) this.log(`[P&L] Statistics entry saved successfully. Total entries now: ${stats.length}`);

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
      if (this.debug && this.getSetting('statistics_debug')) {
        this.log('[P&L] CRITICAL: updateProfitCapabilities() ENTERED - this proves the function is being called');
        this.log('[P&L] updateProfitCapabilities() called - START');
      }

      const stats: StatisticsEntry[] = this.getStoreValue('statistics') || [];
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Statistics entries count:', stats.length);

      // Log the statistics data for debugging
      if (this.debug && this.getSetting('statistics_debug') && stats.length > 0) {
        this.log('[P&L] First few statistics entries:', stats.slice(0, 3).map(entry => ({
          timestamp: entry.timestamp,
          type: entry.type,
          energyAmount: entry.energyAmount,
          duration: entry.duration,
          priceAtTime: entry.priceAtTime
        })));
      }

      if (stats.length === 0) {
        if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] No statistics data available, setting all capabilities to 0');
        await this.setCapabilityValueSafe('measure_battery_profit_daily', 0);
        await this.setCapabilityValueSafe('measure_battery_profit_hourly', 0);
        await this.setCapabilityValueSafe('measure_battery_charge_energy_daily', 0);
        await this.setCapabilityValueSafe('measure_battery_discharge_energy_daily', 0);
        await this.setCapabilityValueSafe('measure_battery_savings_daily', 0);
        await this.setCapabilityValueSafe('measure_battery_cost_daily', 0);
        await this.setCapabilityValueSafe('measure_battery_net_profit_daily', 0);
        if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] updateProfitCapabilities() completed - END (no data)');
        return;
      }

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Processing statistics data...');
      const dailyStats = aggregateDailyStats(stats);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Daily stats generated, count:', dailyStats.length);

      const today = new Date().toISOString().split('T')[0];
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Today\'s date:', today);

      const todayStat = dailyStats.find((ds) => ds.date === today);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Today stat found:', !!todayStat);

      const dailyProfit = todayStat ? todayStat.totalProfit : 0;
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Daily profit calculated:', dailyProfit, '€');

      // Log the setCapabilityValue call for daily profit
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_battery_profit_daily to:', dailyProfit);
      await this.setCapabilityValueSafe('measure_battery_profit_daily', dailyProfit);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_battery_profit_daily set successfully');

      // Hourly profit: total daily profit divided by hours elapsed in the day
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const hoursElapsed = (now.getTime() - startOfDay.getTime()) / (1000 * 60 * 60);
      const hourlyProfit = (hoursElapsed > 0) ? dailyProfit / hoursElapsed : 0;
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Hourly profit calculated:', hourlyProfit, '€/h');

      // Log the setCapabilityValue call for hourly profit
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_battery_profit_hourly to:', hourlyProfit);
      await this.setCapabilityValueSafe('measure_battery_profit_hourly', hourlyProfit);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_battery_profit_hourly set successfully');

      // Update detailed breakdown capabilities
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Calculating detailed breakdown...');
      const breakdown = calculateDetailedBreakdown(stats);

      if (this.debug || this.getSetting('statistics_transparency') || this.getSetting('show_calculation_details')) {
        this.log('[P&L] Detailed breakdown: charge_energy=', breakdown.chargeEnergy, 'kWh, discharge_energy=', breakdown.dischargeEnergy, 'kWh, savings=', breakdown.savings, '€, cost=', breakdown.cost, '€, net_profit=', breakdown.netProfit, '€');
      }

      // Log each setCapabilityValue call for detailed breakdown
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_battery_charge_energy_daily to:', breakdown.chargeEnergy);
      await this.setCapabilityValueSafe('measure_battery_charge_energy_daily', breakdown.chargeEnergy);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_battery_charge_energy_daily set successfully');

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_battery_discharge_energy_daily to:', breakdown.dischargeEnergy);
      await this.setCapabilityValueSafe('measure_battery_discharge_energy_daily', breakdown.dischargeEnergy);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_battery_discharge_energy_daily set successfully');

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_battery_savings_daily to:', breakdown.savings);
      await this.setCapabilityValueSafe('measure_battery_savings_daily', breakdown.savings);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_battery_savings_daily set successfully');

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_battery_cost_daily to:', breakdown.cost);
      await this.setCapabilityValueSafe('measure_battery_cost_daily', breakdown.cost);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_battery_cost_daily set successfully');

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_battery_net_profit_daily to:', breakdown.netProfit);
      await this.setCapabilityValueSafe('measure_battery_net_profit_daily', breakdown.netProfit);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_battery_net_profit_daily set successfully');

      // Update real-time calculation display capabilities
      const currentPrice = this.getCurrentEnergyPrice();
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_current_energy_price to:', currentPrice);
      await this.setCapabilityValueSafe('measure_current_energy_price', currentPrice);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_current_energy_price set successfully');

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_calculation_method to: hybrid');
      await this.setCapabilityValueSafe('measure_calculation_method', 'hybrid');
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_calculation_method set successfully');

      const timestamp = Math.floor(Date.now() / 1000);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Setting measure_calculation_timestamp to:', timestamp);
      await this.setCapabilityValueSafe('measure_calculation_timestamp', timestamp);
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] measure_calculation_timestamp set successfully');

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Aggregation outputs updated: daily_profit=', dailyProfit, ', charge_energy=', breakdown.chargeEnergy, ', discharge_energy=', breakdown.dischargeEnergy, ', savings=', breakdown.savings, ', cost=', breakdown.cost, ', net_profit=', breakdown.netProfit);

      // Force UI refresh to ensure Homey app displays the updated values
      await this.forceUIRefresh();

      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] updateProfitCapabilities() completed - END');
    }

    /**
     * Reset all accumulated statistics data for this device.
     * Clears the statistics store and grid counter accumulator, then updates capabilities to reflect the reset.
     * This operation is thread-safe and cannot be undone.
     */
    async resetStatistics(): Promise<void> {
      // Wait for lock to be released if another operation is in progress
      while (this.statisticsLock) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Acquire lock
      this.statisticsLock = true;

      try {
        // Clear the statistics store
        await this.setStoreValue('statistics', []);

        // Clear the grid counter accumulator store
        await this.setStoreValue(MarstekVenusDevice.GRID_COUNTER_ACCUMULATOR_STORE_KEY, null);

        // Reset all profit-related capabilities to 0
        const profitCapabilities = [
          'measure_battery_profit_daily',
          'measure_battery_profit_hourly',
          'measure_battery_charge_energy_daily',
          'measure_battery_discharge_energy_daily',
          'measure_battery_savings_daily',
          'measure_battery_cost_daily',
          'measure_battery_net_profit_daily',
        ];

        for (const cap of profitCapabilities) {
          await this.setCapabilityValueSafe(cap, 0);
        }

        // Update calculation timestamp to current time
        const timestamp = Math.floor(Date.now() / 1000);
        await this.setCapabilityValueSafe('measure_calculation_timestamp', timestamp);

        // Keep current energy price and calculation method as-is

        if (this.debug) {
          this.log('Statistics reset completed successfully');
        }

      } finally {
        // Release lock
        this.statisticsLock = false;
      }
    }

    /**
     * Safely set a capability value with proper formatting and error handling
     * @param capability The capability name
     * @param value The value to set
     */
    async setCapabilityValueSafe(capability: string, value: any): Promise<void> {
      try {
        // Ensure value is a valid number for numeric capabilities
        if (typeof value === 'number' && !Number.isFinite(value)) {
          if (this.debug) {
            this.log(`[P&L] WARNING: Invalid numeric value ${value} for capability ${capability}, setting to 0`);
          }
          value = 0;
        }

        // Format the value based on capability type
        let formattedValue = value;
        if (typeof value === 'number') {
          // Round to appropriate decimal places based on capability
          if (capability.includes('profit') || capability.includes('savings') || capability.includes('cost')) {
            formattedValue = Math.round(value * 100) / 100; // 2 decimal places for currency
          } else if (capability.includes('energy')) {
            formattedValue = Math.round(value * 1000) / 1000; // 3 decimal places for energy
          } else if (capability.includes('price')) {
            formattedValue = Math.round(value * 10000) / 10000; // 4 decimal places for price
          } else {
            formattedValue = Math.round(value * 10) / 10; // 1 decimal place for others
          }
        }

        // Set the capability value
        await this.setCapabilityValue(capability, formattedValue);
        
        // Log the successful setting
        if (this.debug && this.getSetting('statistics_debug')) {
          this.log(`[P&L] Successfully set ${capability} to ${formattedValue} (original: ${value})`);
        }
      } catch (error) {
        this.error(`[P&L] Failed to set capability ${capability} to ${value}:`, error);
      }
    }

    /**
     * Force UI refresh for P&L capabilities to ensure Homey app displays updated values
     */
    async forceUIRefresh() {
      if (this.debug && this.getSetting('statistics_debug')) this.log('[P&L] Forcing UI refresh for P&L capabilities');

      const pnlCapabilities = [
        'measure_battery_profit_daily',
        'measure_battery_profit_hourly',
        'measure_battery_charge_energy_daily',
        'measure_battery_discharge_energy_daily',
        'measure_battery_savings_daily',
        'measure_battery_cost_daily',
        'measure_battery_net_profit_daily',
        'measure_calculation_timestamp',
        'measure_current_energy_price',
        'measure_calculation_method'
      ];

      try {
        // Get current values and re-set them to trigger UI refresh
        for (const capability of pnlCapabilities) {
          if (this.hasCapability(capability)) {
            const currentValue = await this.getCapabilityValue(capability);
            if (currentValue !== null && currentValue !== undefined) {
              // Small delay to ensure Homey processes each update
              await new Promise(resolve => setTimeout(resolve, 10));
              await this.setCapabilityValue(capability, currentValue);
              if (this.debug && this.getSetting('statistics_debug')) {
                this.log(`[P&L] UI refresh: ${capability} re-set to ${currentValue}`);
              }
            }
          }
        }
      } catch (error) {
        this.error('[P&L] Failed to force UI refresh:', error);
      }
    }

    /**
     * Check and trigger battery-related flow cards based on state changes
     * @param result The API response result containing battery data
     */
    private async checkAndTriggerBatteryFlows(result: any): Promise<void> {
       try {
         // Check SOC threshold triggers
         if (!isNaN(result.bat_soc)) {
           await this.checkAndTriggerSocThreshold(result.bat_soc);
         }

         // Check charging state change triggers
         if (!isNaN(result.bat_power)) {
           const currentChargingState = (result.bat_power > 0) ? 'charging' :
                                         (result.bat_power < 0) ? 'discharging' : 'idle';
           await this.checkAndTriggerChargingStateChange(currentChargingState, result.bat_soc, result.bat_power);
         }

         // Check temperature threshold triggers
         if (!isNaN(result.bat_temp)) {
           let temperature = result.bat_temp;
           // Apply same temperature adjustment as in main processing
           if (temperature > 50) temperature /= 10.0;
           await this.checkAndTriggerTemperatureWarning(temperature);
         }

         // Check grid power direction changes
         await this.checkAndTriggerGridPowerChange(result);

         // Check solar generation triggers
         if (!isNaN(result.pv_power)) {
           await this.checkAndTriggerSolarFlows(result.pv_power);
         }
       } catch (error) {
         this.error('Error checking battery flow triggers:', error);
       }
     }

    /**
     * Check and trigger SOC threshold flow cards
     * @param currentSoc Current battery SOC value
     */
    private async checkAndTriggerSocThreshold(currentSoc: number): Promise<void> {
      // Only trigger if we have a previous value to compare against
      if (this.lastSocValue === null) {
        this.lastSocValue = currentSoc;
        return;
      }

      // Check if threshold was crossed (we trigger for all possible thresholds and directions)
      // Homey's flow engine will filter to only active flows that match
      const crossedAbove = this.lastSocValue <= currentSoc; // SOC increased
      const crossedBelow = this.lastSocValue >= currentSoc; // SOC decreased

      if (crossedAbove || crossedBelow) {
        // Trigger for all possible threshold crossings
        // Homey will only execute flows that match the current SOC and threshold conditions
        await this.homey.flow.getTriggerCard('marstek_battery_soc_threshold').trigger({
          soc: currentSoc,
          threshold: currentSoc, // This will be matched against flow conditions
          direction: crossedAbove ? 'above' : 'below'
        });

        if (this.debug) {
          this.log(`SOC threshold trigger fired: ${this.lastSocValue}% -> ${currentSoc}%`);
        }
      }

      this.lastSocValue = currentSoc;
    }

    /**
     * Check and trigger charging state change flow cards
     * @param currentState Current charging state
     * @param soc Current SOC value
     * @param power Current power value
     */
    private async checkAndTriggerChargingStateChange(currentState: string, soc: number, power: number): Promise<void> {
      // Only trigger if we have a previous state to compare against
      if (this.lastChargingState === null) {
        this.lastChargingState = currentState;
        return;
      }

      // Check if state actually changed
      if (this.lastChargingState === currentState) {
        return;
      }

      // Determine the type of state change
      let stateChangeType = '';
      if (this.lastChargingState !== 'charging' && currentState === 'charging') {
        stateChangeType = 'starts_charging';
      } else if (this.lastChargingState === 'charging' && currentState !== 'charging') {
        stateChangeType = 'stops_charging';
      } else if (this.lastChargingState !== 'discharging' && currentState === 'discharging') {
        stateChangeType = 'starts_discharging';
      } else if (this.lastChargingState === 'discharging' && currentState !== 'discharging') {
        stateChangeType = 'stops_discharging';
      } else if (this.lastChargingState !== 'idle' && currentState === 'idle') {
        stateChangeType = 'becomes_idle';
      }

      if (stateChangeType) {
        // Trigger the flow card - Homey will filter to flows that match this state change
        await this.homey.flow.getTriggerCard('marstek_battery_charging_state_changed').trigger({
          state: stateChangeType,
          previous_state: this.lastChargingState,
          soc: soc,
          power: power
        });

        if (this.debug) {
          this.log(`Charging state change trigger fired: ${this.lastChargingState} -> ${currentState} (${stateChangeType})`);
        }
      }

      this.lastChargingState = currentState;
    }

    /**
     * Check and trigger temperature warning flow cards
     * @param currentTemperature Current battery temperature value
     */
    private async checkAndTriggerTemperatureWarning(currentTemperature: number): Promise<void> {
      // Only trigger if we have a previous value to compare against
      if (this.lastTemperatureValue === null) {
        this.lastTemperatureValue = currentTemperature;
        return;
      }

      // Check if threshold was crossed (we trigger for all possible thresholds and directions)
      // Homey's flow engine will filter to only active flows that match
      const crossedAbove = this.lastTemperatureValue <= currentTemperature; // Temperature increased
      const crossedBelow = this.lastTemperatureValue >= currentTemperature; // Temperature decreased

      if (crossedAbove || crossedBelow) {
        // Trigger for all possible threshold crossings
        // Homey will only execute flows that match the current temperature and threshold conditions
        await this.homey.flow.getTriggerCard('marstek_temperature_warning').trigger({
          temperature: currentTemperature,
          threshold: currentTemperature, // This will be matched against flow conditions
          direction: crossedAbove ? 'above' : 'below'
        });

        if (this.debug) {
          this.log(`Temperature warning trigger fired: ${this.lastTemperatureValue}°C -> ${currentTemperature}°C`);
        }
      }

      this.lastTemperatureValue = currentTemperature;
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

  /**
   * Check and trigger grid power direction change flow cards
   * @param result The API response result containing grid power data
   */
  private async checkAndTriggerGridPowerChange(result: any): Promise<void> {
    try {
      if (!isNaN(result.ongrid_power)) {
        const gridPower = result.ongrid_power * -1; // measure_power_ongrid value
        const currentDirection: 'import' | 'export' | 'idle' =
          gridPower > 0 ? 'import' :
          gridPower < 0 ? 'export' : 'idle';

        // Only trigger if we have a previous direction to compare against
        if (this.lastGridPowerDirection === null) {
          this.lastGridPowerDirection = currentDirection;
          return;
        }

        // Check if direction actually changed
        if (this.lastGridPowerDirection === currentDirection) {
          return;
        }

        // Trigger appropriate flow card when direction changes to import or export
        if (currentDirection === 'import' && this.lastGridPowerDirection !== 'import') {
          await this.homey.flow.getTriggerCard('marstek_grid_import_starts').trigger({
            power: gridPower,
            direction: 'import'
          });
          if (this.debug) {
            this.log(`Grid import starts trigger fired: ${this.lastGridPowerDirection} -> ${currentDirection} (${gridPower}W)`);
          }
        } else if (currentDirection === 'export' && this.lastGridPowerDirection !== 'export') {
          await this.homey.flow.getTriggerCard('marstek_grid_export_starts').trigger({
            power: gridPower,
            direction: 'export'
          });
          if (this.debug) {
            this.log(`Grid export starts trigger fired: ${this.lastGridPowerDirection} -> ${currentDirection} (${gridPower}W)`);
          }
        }

        this.lastGridPowerDirection = currentDirection;
      }
    } catch (error) {
      this.error('Error checking grid power flow triggers:', error);
    }
  }

  /**
   * Check and trigger solar generation flow cards based on PV power changes
   * @param currentPvPower Current PV power value in watts
   */
  private async checkAndTriggerSolarFlows(currentPvPower: number): Promise<void> {
    try {
      // Only trigger if we have a previous value to compare against
      if (this.lastPvPowerValue === null) {
        this.lastPvPowerValue = currentPvPower;
        return;
      }

      // Check if threshold was crossed (we trigger for all possible thresholds and directions)
      // Homey's flow engine will filter to only active flows that match
      const crossedAbove = this.lastPvPowerValue <= currentPvPower; // PV power increased
      const crossedBelow = this.lastPvPowerValue >= currentPvPower; // PV power decreased

      if (crossedAbove || crossedBelow) {
        // Trigger for all possible threshold crossings
        // Homey will only execute flows that match the current PV power and threshold conditions
        await this.homey.flow.getTriggerCard('marstek_solar_generation_starts').trigger({
          power: currentPvPower,
          threshold: currentPvPower, // This will be matched against flow conditions
        });

        await this.homey.flow.getTriggerCard('marstek_solar_generation_stops').trigger({
          power: currentPvPower,
          threshold: currentPvPower, // This will be matched against flow conditions
        });

        if (this.debug) {
          this.log(`Solar generation triggers fired: ${this.lastPvPowerValue}W -> ${currentPvPower}W`);
        }
      }

      this.lastPvPowerValue = currentPvPower;
    } catch (error) {
      this.error('Error checking solar flow triggers:', error);
    }
  }

  /**
   * Check and trigger mode change flow cards
   * @param currentMode Current battery mode
   */
  private async checkAndTriggerModeChange(currentMode: string): Promise<void> {
    try {
      // Only trigger if we have a previous mode to compare against
      if (this.lastMode === null) {
        this.lastMode = currentMode;
        return;
      }

      // Check if mode actually changed
      if (this.lastMode === currentMode) {
        return;
      }

      // Trigger the mode change flow card
      await this.homey.flow.getTriggerCard('marstek_mode_changed').trigger({
        mode: currentMode,
        previous_mode: this.lastMode
      }, {
        mode: currentMode,
        previous_mode: this.lastMode
      });

      if (this.debug) {
        this.log(`Mode change trigger fired: ${this.lastMode} -> ${currentMode}`);
      }

      this.lastMode = currentMode;
    } catch (error) {
      this.error('Error checking mode change flow triggers:', error);
    }
  }

}

// Also use module.exports for Homey
module.exports = MarstekVenusDevice;
