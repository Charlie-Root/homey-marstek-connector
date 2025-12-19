import Homey from 'homey';
import type MarstekVenusCloudDriver from './driver';
import type MarstekCloud from '../../lib/marstek-cloud';

// Import our loaded config
import { config } from '../../lib/config';

// Import statistics utilities with enhanced safety features
import {
  StatisticsEntry, calculateEnergyAmount, cleanupOldEntries, aggregateDailyStats, calculateDetailedBreakdown,
  logStatisticsEntry, getCalculationAuditTrail, getStatisticsSummary,
  getHistoricalValuesOptimized,
} from '../../lib/statistics-utils';

// Import validation utilities
import {
  validateEnergyPrice as validateEnergyPriceUtil,
} from '../../lib/financial-calculator';

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
    private pollInterval?: NodeJS.Timeout = undefined; // handle for interval used for polling data
    private lastInterval?: NodeJS.Timeout = undefined; // handle for interval used for updating last message received

    // Timestamp last received details
    private timestamp?: Date = undefined;

    // Cast pointers to our app
    private myDriver: MarstekVenusCloudDriver = this.driver as MarstekVenusCloudDriver;

    // Statistics tracking
    private previousChargingState?: string = undefined;
    private eventStartTime?: Date = undefined;
    private cumulativeEnergy: number = 0;

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
      await this.setCapabilityValue('measure_battery_profit_daily', null);
      await this.setCapabilityValue('measure_battery_profit_hourly', null);
      await this.setCapabilityValue('measure_battery_charge_energy_daily', null);
      await this.setCapabilityValue('measure_battery_discharge_energy_daily', null);
      await this.setCapabilityValue('measure_battery_savings_daily', null);
      await this.setCapabilityValue('measure_battery_cost_daily', null);
      await this.setCapabilityValue('measure_battery_net_profit_daily', null);
      await this.setCapabilityValue('measure_calculation_timestamp', null);
      await this.setCapabilityValue('measure_current_energy_price', null);
      await this.setCapabilityValue('measure_calculation_method', null);
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
      if (!isNaN(status.soc)) await this.setCapabilityValue('measure_battery', status.soc);

      // Power (charge minus discharge)
      await this.setCapabilityValue('measure_power', status.charge - status.discharge);
      await this.setCapabilityValue('measure_power.charge', status.charge);
      await this.setCapabilityValue('measure_power.discharge', status.discharge);

      // Statistics tracking with enhanced safety and validation
      if (this.getSetting('enable_statistics')) {
        const currentChargingState = status.charge > 0 ? 'charging' : status.discharge > 0 ? 'discharging' : 'idle';
        const now = new Date(status.report_time * 1000);
        const timeDiffHours = this.timestamp ? (now.getTime() - this.timestamp.getTime()) / (1000 * 60 * 60) : 0;

        // Get historical energy values for outlier detection (optimized)
        const historicalStats: StatisticsEntry[] = this.getStoreValue('statistics') || [];
        const historicalEnergyValues = getHistoricalValuesOptimized(historicalStats, 10);

        if (this.previousChargingState !== currentChargingState) {
          // Log previous event
          if (this.previousChargingState && this.previousChargingState !== 'idle' && this.eventStartTime) {
            const duration = (now.getTime() - this.eventStartTime.getTime()) / 60000;
            const price = this.getCurrentEnergyPrice();

            // Validate price before using it
            const priceValidation = validateEnergyPriceUtil(price);
            if (!priceValidation.isValid) {
              this.error(`Invalid energy price: ${priceValidation.error}`);
              return;
            }

            const entry: StatisticsEntry = {
              timestamp: Math.floor(this.eventStartTime.getTime() / 1000),
              type: this.previousChargingState as 'charging' | 'discharging',
              energyAmount: this.cumulativeEnergy,
              duration,
              priceAtTime: price,
              calculationAudit: {
                precisionLoss: 0,
                validationWarnings: [],
                calculationMethod: 'enhanced_power_based',
                isOutlier: false,
                recoveryActions: [],
              },
            };

            const power = this.previousChargingState === 'charging' ? status.charge : status.discharge;
            const calculationDetails = {
              method: 'enhanced_power_based',
              inputs: {
                power,
                timeDiffHours,
                cumulativeEnergy: this.cumulativeEnergy,
                historicalValuesCount: historicalEnergyValues.length,
              },
              intermediateSteps: [
                `Power: ${power} W, Time: ${timeDiffHours} hours`,
                `Energy: ${this.cumulativeEnergy.toFixed(3)} kWh`,
              ],
            };

            logStatisticsEntry(entry, {
              debug: this.getSetting('statistics_debug'),
              transparency: this.getSetting('statistics_transparency'),
            }, this.log.bind(this), calculationDetails);
            await this.logStatisticsEntry(entry);
          }
          // Start new event
          if (currentChargingState !== 'idle') {
            this.eventStartTime = now;
            this.cumulativeEnergy = 0;
          } else {
            this.eventStartTime = undefined;
            this.cumulativeEnergy = 0;
          }
          this.previousChargingState = currentChargingState;
        } else if (currentChargingState !== 'idle' && timeDiffHours > 0) {
          // Accumulate energy during active state
          const power = currentChargingState === 'charging' ? status.charge : status.discharge;

          // Use enhanced calculateEnergyAmount with outlier detection
          const energyResult = calculateEnergyAmount(
            currentChargingState as 'charging' | 'discharging',
            undefined,
            undefined,
            undefined,
            power,
            timeDiffHours,
            historicalEnergyValues,
          );

          this.cumulativeEnergy += energyResult.energyAmount;

          // Log warnings if any
          for (const warning of energyResult.warnings) {
            this.log(`Energy accumulation warning: ${warning}`);
          }
        }
      }
      // Update profit capabilities if statistics are enabled
      if (this.getSetting('enable_statistics')) {
        await this.updateProfitCapabilities();
      }
    }

    /**
     * Get the current energy price from settings with validation
     * @returns {number} Current energy price in €/kWh
     */
    getCurrentEnergyPrice(): number {
      const price = this.getSetting('price_per_kwh') ?? 0.30;

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
        calculationMethod: 'power_based',
      };

      await this.homey.flow.getTriggerCard('statistics_entry_logged').trigger(this, {
        entryType: entry.type === 'charging' ? 'charge' : 'discharge',
        timestamp: entry.timestamp,
        value: Math.abs(entry.energyAmount),
        calculation_details: JSON.stringify(calculationDetails),
        energy_price: entry.priceAtTime,
        calculation_method: 'power_based',
      });

      // Trigger flow card for calculation completed
      await this.homey.flow.getTriggerCard('calculation_completed').trigger(this, {
        calculationType: entry.type === 'charging' ? 'charge' : 'discharge',
        timestamp: entry.timestamp,
        result: Math.abs(entry.energyAmount),
        input_data: JSON.stringify({
          duration: entry.duration,
        }),
        energy_price: entry.priceAtTime,
        calculation_method: 'power_based',
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
      await this.setCapabilityValue('measure_calculation_method', 'power_based');
      await this.setCapabilityValue('measure_calculation_timestamp', Math.floor(Date.now() / 1000));
    }

    /** Retrieve our current debug setting, based on actual setting and version */
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
     * Memory-optimized verification report generation for cloud device
     * @param {string} timePeriod Time period to verify (last_hour, last_day, last_week, last_month)
     * @param {boolean} includeDetails Whether to include detailed breakdown
     * @returns {Promise<string>} Optimized verification report
     */
    async verifyCalculation(timePeriod: string, includeDetails: boolean): Promise<string> {
      const stats: StatisticsEntry[] = this.getStoreValue('statistics') || [];
      if (stats.length === 0) {
        return 'No statistics data available for verification';
      }

      // Calculate time range
      const currentTime = Date.now();
      let startTime: number;
      switch (timePeriod) {
        case 'last_hour':
          startTime = currentTime - (60 * 60 * 1000);
          break;
        case 'last_day':
          startTime = currentTime - (24 * 60 * 60 * 1000);
          break;
        case 'last_week':
          startTime = currentTime - (7 * 24 * 60 * 60 * 1000);
          break;
        case 'last_month':
          startTime = currentTime - (30 * 24 * 60 * 60 * 1000);
          break;
        default:
          return 'Invalid time period';
      }

      const auditTrail = getCalculationAuditTrail(stats, startTime / 1000, currentTime / 1000);

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
      const periodStats = stats.filter((s) => s.timestamp >= startTime / 1000 && s.timestamp < currentTime / 1000);
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
}

// Also use module.exports for Homey
module.exports = MarstekVenusCloudDevice;
