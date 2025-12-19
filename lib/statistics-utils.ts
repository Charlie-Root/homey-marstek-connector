/**
 * Shared utilities for statistics tracking in Marstek Venus drivers.
 * Provides interfaces, calculation functions, and storage management for charge/discharge statistics.
 */

export interface StatisticsEntry {
  timestamp: number; // Unix timestamp in milliseconds
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
    const date = new Date(entry.timestamp).toISOString().split('T')[0];
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
 * Cleans up old statistics entries beyond retention days.
 * @param entries - Array of statistics entries
 * @param retentionDays - Number of days to retain
 * @returns Filtered array of entries
 */
export function cleanupOldEntries(entries: StatisticsEntry[], retentionDays: number): StatisticsEntry[] {
  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  return entries.filter((entry) => entry.timestamp >= cutoff);
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
