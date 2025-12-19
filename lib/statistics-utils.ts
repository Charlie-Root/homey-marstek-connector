/**
 * Shared utilities for statistics tracking in Marstek Venus drivers.
 * Provides interfaces, calculation functions, and storage management for charge/discharge statistics.
 */

export interface StatisticsEntry {
  timestamp: number; // Unix timestamp in seconds
  type: 'charging' | 'discharging'; // Event type
  energyAmount: number; // Energy transferred in kWh (positive for charge, negative for discharge)
  duration: number; // Duration in minutes
  priceAtTime?: number | null; // Energy price in currency/kWh at event time, null if unavailable
  startEnergyMeter?: number; // Meter reading at start (for local driver)
  endEnergyMeter?: number; // Meter reading at end (for local driver)
}

export interface DailyStats {
  date: string; // ISO date string (YYYY-MM-DD)
  totalChargeEnergy: number; // Total energy charged in kWh
  totalDischargeEnergy: number; // Total energy discharged in kWh
  totalProfit: number; // Net profit in currency (positive = profit, negative = loss)
  totalSavings: number; // Savings compared to grid prices in currency
  events: StatisticsEntry[]; // Array of events for the day
}

export interface StatisticsSettings {
  enabled: boolean; // Enable/disable statistics collection
  retentionDays: number; // Number of days to retain data (default: 30)
  exportFormat: 'csv' | 'json'; // Preferred export format
}

/**
 * Calculates the energy amount for a statistics entry.
 * For local driver: energyAmount = (endMeter - startMeter) / divisor
 * For cloud driver: energyAmount = (power * timeIntervalHours)
 * @param type - 'charging' or 'discharging'
 * @param startMeter - Starting meter value (local driver)
 * @param endMeter - Ending meter value (local driver)
 * @param divisor - Divisor for meter scaling (local driver, e.g., 10 or 100)
 * @param power - Power in W (cloud driver)
 * @param timeIntervalHours - Time interval in hours (cloud driver)
 * @returns Energy amount in kWh
 */
export function calculateEnergyAmount(
  type: 'charging' | 'discharging',
  startMeter?: number,
  endMeter?: number,
  divisor?: number,
  power?: number,
  timeIntervalHours?: number,
): number {
  if (startMeter !== undefined && endMeter !== undefined && divisor) {
    // Local driver calculation
    const delta = type === 'charging' ? endMeter - startMeter : startMeter - endMeter;
    return delta / divisor;
  } if (power !== undefined && timeIntervalHours !== undefined) {
    // Cloud driver calculation
    return (power / 1000) * timeIntervalHours; // Convert W to kW, multiply by hours
  }
  return 0;
}

/**
 * Calculates profit/savings for a statistics entry.
 * For discharge: savings = energyDischarged * priceAtDischarge
 * For charge: cost = energyCharged * priceAtCharge
 * Net profit = savings - cost (but per entry, it's the savings or negative cost)
 * @param entry - The statistics entry
 * @returns Profit/savings in currency
 */
export function calculateProfitSavings(entry: StatisticsEntry): number {
  if (!entry.priceAtTime) return 0;
  if (entry.type === 'discharging') {
    // Savings from discharging (avoiding grid consumption)
    return Math.abs(entry.energyAmount) * entry.priceAtTime;
  }
  // Cost of charging
  return -Math.abs(entry.energyAmount) * entry.priceAtTime;

}

/**
 * Aggregates statistics entries into daily stats.
 * @param entries - Array of statistics entries
 * @returns Array of DailyStats
 */
export function aggregateDailyStats(entries: StatisticsEntry[]): DailyStats[] {
  const dailyMap = new Map<string, DailyStats>();

  for (const entry of entries) {
    const date = new Date(entry.timestamp * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        totalChargeEnergy: 0,
        totalDischargeEnergy: 0,
        totalProfit: 0,
        totalSavings: 0,
        events: [],
      });
    }
    const day = dailyMap.get(date)!;
    day.events.push(entry);

    if (entry.type === 'charging') {
      day.totalChargeEnergy += entry.energyAmount;
    } else {
      day.totalDischargeEnergy += Math.abs(entry.energyAmount);
    }

    const profitSavings = calculateProfitSavings(entry);
    if (entry.type === 'discharging') {
      day.totalSavings += profitSavings;
    }
    day.totalProfit += profitSavings;
  }

  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Calculates detailed breakdown metrics for daily statistics.
 * @param entries - Array of statistics entries
 * @returns Object with detailed breakdown metrics
 */
export function calculateDetailedBreakdown(entries: StatisticsEntry[]) {
  const dailyStats = aggregateDailyStats(entries);
  const today = new Date().toISOString().split('T')[0];
  const todayStat = dailyStats.find((ds) => ds.date === today);

  if (!todayStat) {
    return {
      chargeEnergy: 0,
      dischargeEnergy: 0,
      savings: 0,
      cost: 0,
      netProfit: 0,
    };
  }

  // Calculate detailed breakdown
  let chargeEnergy = 0;
  let dischargeEnergy = 0;
  let savings = 0;
  let cost = 0;

  for (const entry of todayStat.events) {
    if (entry.type === 'charging') {
      chargeEnergy += Math.abs(entry.energyAmount);
      if (entry.priceAtTime) {
        cost += Math.abs(entry.energyAmount) * entry.priceAtTime;
      }
    } else if (entry.type === 'discharging') {
      dischargeEnergy += Math.abs(entry.energyAmount);
      if (entry.priceAtTime) {
        savings += Math.abs(entry.energyAmount) * entry.priceAtTime;
      }
    }
  }

  const netProfit = savings - cost;

  return {
    chargeEnergy,
    dischargeEnergy,
    savings,
    cost,
    netProfit,
  };
}

/**
 * Cleans up old statistics entries beyond retention days.
 * @param entries - Array of statistics entries
 * @param retentionDays - Number of days to retain
 * @returns Filtered array of entries
 */
export function cleanupOldEntries(entries: StatisticsEntry[], retentionDays: number): StatisticsEntry[] {
  const cutoff = Date.now() / 1000 - (retentionDays * 24 * 60 * 60);
  return entries.filter((entry) => entry.timestamp >= cutoff);
}

/**
 * Logs a statistics entry with detailed calculation information for audit and verification.
 * @param entry - The statistics entry to log
 * @param settings - Statistics settings for transparency mode
 * @param logger - Logger function (e.g., this.log from Homey device)
 * @param calculationDetails - Additional calculation details
 */
export function logStatisticsEntry(
  entry: StatisticsEntry,
  settings: { debug: boolean; transparency: boolean },
  logger: (message: string) => void,
  calculationDetails?: {
    method: string,
    inputs: Record<string, any>,
    intermediateSteps?: any[],
  },
): void {
  if (!settings.debug && !settings.transparency) return;

  const timestamp = new Date(entry.timestamp * 1000).toISOString();
  const baseLog = `[${timestamp}] ${entry.type.toUpperCase()} - Energy: ${entry.energyAmount.toFixed(3)} kWh, Duration: ${entry.duration} min`;

  if (entry.priceAtTime) {
    const profitSavings = calculateProfitSavings(entry);
    const priceInfo = `, Price: €${entry.priceAtTime.toFixed(4)}/kWh, Profit/Savings: €${profitSavings.toFixed(2)}`;
    logger(`${baseLog}${priceInfo}`);
  } else {
    logger(`${baseLog}, Price: N/A`);
  }

  if (settings.transparency && calculationDetails) {
    logger(`  Calculation Method: ${calculationDetails.method}`);
    logger(`  Inputs: ${JSON.stringify(calculationDetails.inputs, null, 2)}`);
    if (calculationDetails.intermediateSteps) {
      logger(`  Intermediate Steps: ${JSON.stringify(calculationDetails.intermediateSteps, null, 2)}`);
    }
  }

  if (entry.startEnergyMeter !== undefined && entry.endEnergyMeter !== undefined) {
    logger(`  Meter Reading: ${entry.startEnergyMeter} -> ${entry.endEnergyMeter}`);
  }
}

/**
 * Retrieves the calculation audit trail for a given time period.
 * @param entries - Array of statistics entries
 * @param startTime - Start timestamp (inclusive)
 * @param endTime - End timestamp (exclusive)
 * @returns Array of audit trail entries with calculation details
 */
export function getCalculationAuditTrail(
  entries: StatisticsEntry[],
  startTime: number,
  endTime: number,
): Array<{
  entry: StatisticsEntry,
  verification: {
    energyValid: boolean,
    profitValid: boolean,
    timestampValid: boolean,
    details: string,
  },
}> {
  const filteredEntries = entries.filter((e) => e.timestamp >= startTime && e.timestamp < endTime);

  return filteredEntries.map((entry) => {
    const energyValid = !isNaN(entry.energyAmount) && entry.energyAmount !== 0;
    const profitSavings = calculateProfitSavings(entry);
    const profitValid = !isNaN(profitSavings);
    const timestampValid = entry.timestamp > 0 && entry.timestamp <= Date.now() / 1000;

    let details = `Energy: ${entry.energyAmount.toFixed(3)} kWh (${energyValid ? 'valid' : 'invalid'})`;
    if (entry.priceAtTime) {
      details += `, Profit/Savings: €${profitSavings.toFixed(2)} (${profitValid ? 'valid' : 'invalid'})`;
    }
    details += `, Timestamp: ${new Date(entry.timestamp).toISOString()} (${timestampValid ? 'valid' : 'invalid'})`;

    return {
      entry,
      verification: {
        energyValid,
        profitValid,
        timestampValid,
        details,
      },
    };
  });
}

/**
 * Gets the default statistics settings.
 * @returns Default StatisticsSettings
 */
export function getDefaultStatisticsSettings(): StatisticsSettings {
  return {
    enabled: false,
    retentionDays: 30,
    exportFormat: 'json',
  };
}
