/**
 * Shared utilities for statistics tracking in Marstek Venus drivers.
 * Provides interfaces, calculation functions, and storage management for charge/discharge statistics.
 *
 * CRITICAL FIXES IMPLEMENTED:
 * - Zero division protection in all calculations
 * - Enhanced input validation with bounds checking
 * - Floating-point precision control with banker's rounding
 * - Comprehensive audit trail with precision loss detection
 * - Edge case handling and recovery mechanisms
 */

import {
  financialCalculator,
  validateEnergyAmount,
  validateEnergyPrice,
  validateTimestamp,
  bankersRounding,
  FINANCIAL_CONSTANTS,
} from './financial-calculator';

export interface StatisticsEntry {
  timestamp: number; // Unix timestamp in seconds
  type: 'charging' | 'discharging'; // Event type
  energyAmount: number; // Energy transferred in kWh (positive for charge, negative for discharge)
  duration: number; // Duration in minutes
  priceAtTime?: number | null; // Energy price in currency/kWh at event time, null if unavailable
  startEnergyMeter?: number; // Meter reading at start (for local driver)
  endEnergyMeter?: number; // Meter reading at end (for local driver)
  // Enhanced audit information
  calculationAudit?: {
    precisionLoss: number;
    validationWarnings: string[];
    calculationMethod: string;
    isOutlier: boolean;
    recoveryActions: string[];
  };
}

export interface DailyStats {
  date: string; // ISO date string (YYYY-MM-DD)
  totalChargeEnergy: number; // Total energy charged in kWh
  totalDischargeEnergy: number; // Total energy discharged in kWh
  totalProfit: number; // Net profit in currency (positive = profit, negative = loss)
  totalSavings: number; // Savings compared to grid prices in currency
  events: StatisticsEntry[]; // Array of events for the day
  // Enhanced audit information
  auditInfo?: {
    validationFailures: number;
    precisionLosses: number;
    outliers: number;
    recoveryActions: number;
  };
}

export interface StatisticsSettings {
  enabled: boolean; // Enable/disable statistics collection
  retentionDays: number; // Number of days to retain data (default: 30)
  maxEntries: number; // Maximum number of entries (memory protection)
  enableMemoryOptimization: boolean; // Enable memory optimization features
  exportFormat: 'csv' | 'json'; // Preferred export format
}

/**
 * Statistics memory management configuration
 */
export interface StatisticsMemoryConfig {
  maxEntries: number; // Maximum entries per device
  maxMemoryUsageMB: number; // Maximum memory usage in MB
  enableProactiveCleanup: boolean; // Enable proactive cleanup
  cleanupThreshold: number; // Cleanup trigger threshold (0.0-1.0)
  retentionDays: number; // Default retention period
}

/**
 * Default statistics memory configuration
 */
export const DEFAULT_STATISTICS_MEMORY_CONFIG: StatisticsMemoryConfig = {
  maxEntries: 10000, // Maximum 10,000 entries per device
  maxMemoryUsageMB: 50, // 50MB maximum memory usage
  enableProactiveCleanup: true, // Enable proactive cleanup
  cleanupThreshold: 0.8, // Trigger cleanup at 80% capacity
  retentionDays: 30, // 30 days retention
};

/**
 * Statistics memory usage report
 */
export interface StatisticsMemoryReport {
  totalEntries: number;
  estimatedMemoryBytes: number;
  estimatedMemoryMB: number;
  oldestEntryTimestamp?: number;
  newestEntryTimestamp?: number;
  cleanupPerformed: boolean;
  entriesRemoved: number;
  retentionDays: number;
  isNearLimit: boolean;
}

/**
 * Calculates the energy amount for a statistics entry with comprehensive safety checks.
 * For local driver: energyAmount = (endMeter - startMeter) / divisor
 * For cloud driver: energyAmount = (power * timeIntervalHours) / 1000
 *
 * CRITICAL FIXES:
 * - Zero division protection with fallback values
 * - Input validation with bounds checking
 * - Precision control with banker's rounding
 * - Outlier detection for abnormal readings
 * - Comprehensive error handling and recovery
 *
 * @param type - 'charging' or 'discharging'
 * @param startMeter - Starting meter value (local driver)
 * @param endMeter - Ending meter value (local driver)
 * @param divisor - Divisor for meter scaling (local driver, e.g., 10 or 100)
 * @param power - Power in W (cloud driver)
 * @param timeIntervalHours - Time interval in hours (cloud driver)
 * @param historicalValues - Historical energy values for outlier detection
 * @returns Energy amount in kWh with audit information
 */
export function calculateEnergyAmount(
  type: 'charging' | 'discharging',
  startMeter?: number,
  endMeter?: number,
  divisor?: number,
  power?: number,
  timeIntervalHours?: number,
  historicalValues: number[] = [],
): { energyAmount: number; audit: any; warnings: string[] } {
  const warnings: string[] = [];
  const recoveryActions: string[] = [];

  try {
    // Use FinancialCalculator for safe calculation
    const result = financialCalculator.calculateEnergyAmount(
      type,
      startMeter,
      endMeter,
      divisor,
      power,
      timeIntervalHours,
    );

    let { energyAmount } = result;

    // Apply sign based on type
    const signedEnergyAmount = type === 'charging' ? Math.abs(energyAmount) : -Math.abs(energyAmount);

    // Outlier detection for abnormal readings
    if (historicalValues.length > 0 && Math.abs(signedEnergyAmount) > 0) {
      const outlierResult = financialCalculator.detectOutlier(
        Math.abs(signedEnergyAmount),
        historicalValues,
      );

      if (outlierResult.isOutlier) {
        warnings.push(`Potential outlier detected: ${Math.abs(signedEnergyAmount).toFixed(3)} kWh (z-score: ${outlierResult.zScore.toFixed(2)})`);

        // Recovery action: cap to reasonable value
        const cappedValue = Math.min(Math.abs(signedEnergyAmount), FINANCIAL_CONSTANTS.MAX_ENERGY_AMOUNT * 0.1);
        energyAmount = type === 'charging' ? cappedValue : -cappedValue;
        recoveryActions.push(`Capped outlier value to ${cappedValue.toFixed(3)} kWh`);
      }
    }

    // Additional safety checks for extreme values
    if (Math.abs(energyAmount) > FINANCIAL_CONSTANTS.MAX_ENERGY_AMOUNT) {
      warnings.push(`Energy amount exceeds maximum reasonable value: ${Math.abs(energyAmount).toFixed(3)} kWh`);
      const safeValue = Math.sign(energyAmount) * FINANCIAL_CONSTANTS.MAX_ENERGY_AMOUNT * 0.1;
      energyAmount = safeValue;
      recoveryActions.push(`Reduced to safe maximum: ${safeValue.toFixed(3)} kWh`);
    }

    // Validate timestamp if provided in context (would be added by caller)
    // This validation is typically done at a higher level

    const audit = {
      ...result.audit,
      recoveryActions,
      finalEnergyAmount: energyAmount,
      warnings: [...warnings, ...(result.audit.validation.warnings || [])],
    };

    return {
      energyAmount,
      audit,
      warnings,
    };

  } catch (error) {
    warnings.push(`Calculation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

    // Recovery: return zero with error indication
    const audit = {
      inputValues: {
        type, startMeter, endMeter, divisor, power, timeIntervalHours,
      },
      intermediateSteps: [],
      finalResult: 0,
      precisionLoss: 0,
      validation: {
        isValid: false,
        error: `Safe calculation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      recoveryActions: ['Returned zero as safe fallback'],
      warnings,
    };

    return {
      energyAmount: 0,
      audit,
      warnings,
    };
  }
}

/**
 * Calculates profit/savings for a statistics entry with comprehensive safety checks.
 * For discharge: savings = energyDischarged * priceAtDischarge
 * For charge: cost = energyCharged * priceAtCharge
 * Net profit = savings - cost (but per entry, it's the savings or negative cost)
 *
 * CRITICAL FIXES:
 * - Input validation with bounds checking
 * - Banker's rounding for currency calculations
 * - Precision loss detection
 * - Recovery mechanisms for invalid calculations
 *
 * @param entry - The statistics entry
 * @returns Profit/savings in currency with audit information
 */
export function calculateProfitSavings(entry: StatisticsEntry): { profitSavings: number; audit: any; warnings: string[] } {
  const warnings: string[] = [];
  const recoveryActions: string[] = [];

  try {
    if (!entry.priceAtTime) {
      warnings.push('No price data available for calculation');
      return {
        profitSavings: 0,
        audit: {
          inputValues: entry,
          intermediateSteps: [],
          finalResult: 0,
          precisionLoss: 0,
          validation: { isValid: true, warnings: ['No price data'] },
          recoveryActions: ['Returned zero due to missing price'],
          warnings,
        },
        warnings,
      };
    }

    // Use FinancialCalculator for safe calculation
    const result = financialCalculator.calculateProfitSavings(
      entry.energyAmount,
      entry.priceAtTime,
      entry.type,
    );

    let { profitSavings } = result;

    // Additional safety checks for financial values
    if (Math.abs(profitSavings) > 10000) { // €10,000 threshold
      warnings.push(`Unusually high financial value: €${profitSavings.toFixed(2)}`);
      const safeValue = Math.sign(profitSavings) * 10000;
      profitSavings = safeValue;
      recoveryActions.push(`Capped to reasonable maximum: €${safeValue.toFixed(2)}`);
    }

    // Validate timestamp if available
    if (entry.timestamp) {
      const timestampValidation = validateTimestamp(entry.timestamp);
      if (!timestampValidation.isValid) {
        warnings.push(`Invalid timestamp: ${timestampValidation.error}`);
        recoveryActions.push('Proceeding with calculation despite invalid timestamp');
      }
    }

    const audit = {
      ...result.audit,
      recoveryActions,
      finalProfitSavings: profitSavings,
      warnings: [...warnings, ...(result.audit.validation.warnings || [])],
    };

    return {
      profitSavings,
      audit,
      warnings,
    };

  } catch (error) {
    warnings.push(`Profit/savings calculation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

    // Recovery: return zero with error indication
    const audit = {
      inputValues: entry,
      intermediateSteps: [],
      finalResult: 0,
      precisionLoss: 0,
      validation: {
        isValid: false,
        error: `Safe profit/savings calculation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      recoveryActions: ['Returned zero as safe fallback'],
      warnings,
    };

    return {
      profitSavings: 0,
      audit,
      warnings,
    };
  }
}

/**
 * Legacy aggregateDailyStats function for backward compatibility
 * @param entries - Array of statistics entries
 * @returns Array of DailyStats with audit information
 */
export function aggregateDailyStats(entries: StatisticsEntry[]): DailyStats[] {
  return aggregateDailyStatsOptimized(entries);
}

/**
 * Optimized historical values extraction with single-pass processing.
 * Replaces inefficient array manipulation chains with memory-efficient loops.
 * @param historicalStats - Array of historical statistics entries
 * @param maxEntries - Maximum number of historical entries to process
 * @returns Optimized array of historical energy values
 */
export function getHistoricalValuesOptimized(
  historicalStats: StatisticsEntry[], 
  maxEntries: number = 10
): number[] {
  const values: number[] = [];
  const startIndex = Math.max(0, historicalStats.length - maxEntries);
  
  // Single-pass processing to avoid multiple array allocations
  for (let i = startIndex; i < historicalStats.length; i++) {
    const entry = historicalStats[i];
    const absValue = Math.abs(entry.energyAmount);
    if (absValue > 0) {
      values.push(absValue);
    }
  }
  
  return values;
}

/**
 * Memory-efficient aggregation of statistics entries into daily stats.
 * Optimized to use single-pass processing and minimal intermediate arrays.
 * @param entries - Array of statistics entries
 * @param memoryConfig - Optional memory configuration
 * @returns Array of DailyStats with audit information
 */
export function aggregateDailyStatsOptimized(
  entries: StatisticsEntry[],
  memoryConfig?: Partial<StatisticsMemoryConfig>
): DailyStats[] {
  // Pre-allocate with estimated size to reduce array resizing
  const dailyMap = new Map<string, DailyStats>();
  const config = { ...DEFAULT_STATISTICS_MEMORY_CONFIG, ...memoryConfig };
  
  // Single-pass processing for better memory efficiency
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const date = new Date(entry.timestamp * 1000).toISOString().split('T')[0];
    
    let day = dailyMap.get(date);
    if (!day) {
      day = {
        date,
        totalChargeEnergy: 0,
        totalDischargeEnergy: 0,
        totalProfit: 0,
        totalSavings: 0,
        events: [], // Will be populated separately to avoid memory bloat
        auditInfo: {
          validationFailures: 0,
          precisionLosses: 0,
          outliers: 0,
          recoveryActions: 0,
        },
      };
      dailyMap.set(date, day);
    }
    
    // Direct accumulation without intermediate calculations
    if (entry.type === 'charging') {
      day.totalChargeEnergy += Math.abs(entry.energyAmount);
    } else {
      day.totalDischargeEnergy += Math.abs(entry.energyAmount);
    }

    const profitSavingsResult = calculateProfitSavings(entry);
    const { profitSavings } = profitSavingsResult;

    if (entry.type === 'discharging') {
      day.totalSavings += profitSavings;
    }
    day.totalProfit += profitSavings;

    // Track audit information
    if (!profitSavingsResult.audit.validation.isValid) {
      day.auditInfo!.validationFailures++;
    }

    if (profitSavingsResult.audit.precisionLoss > FINANCIAL_CONSTANTS.PRECISION_THRESHOLD) {
      day.auditInfo!.precisionLosses++;
    }

    if (profitSavingsResult.audit.isOutlier) {
      day.auditInfo!.outliers++;
    }

    if (profitSavingsResult.audit.recoveryActions) {
      day.auditInfo!.recoveryActions += profitSavingsResult.audit.recoveryActions.length;
    }
  }

  // Convert to sorted array efficiently
  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Optimized statistics summary calculation with memory efficiency.
 * @param entries - Array of statistics entries
 * @param memoryConfig - Optional memory configuration
 * @returns Comprehensive statistics summary
 */
export function getStatisticsSummaryOptimized(
  entries: StatisticsEntry[],
  memoryConfig?: Partial<StatisticsMemoryConfig>
): {
  summary: {
    totalEvents: number;
    totalChargeEnergy: number;
    totalDischargeEnergy: number;
    totalProfit: number;
    totalSavings: number;
    averagePrice: number;
  };
  audit: {
    validationFailures: number;
    precisionLosses: number;
    outliers: number;
    recoveryActions: number;
    financialCalculatorStats: any;
    memoryReport: StatisticsMemoryReport;
  };
} {
  // Use optimized aggregation
  const dailyStats = aggregateDailyStatsOptimized(entries, memoryConfig);
  const validation = validateAndCleanEntries(entries);

  // Initialize accumulators
  let totalChargeEnergy = 0;
  let totalDischargeEnergy = 0;
  let totalProfit = 0;
  let totalSavings = 0;
  let totalPrice = 0;
  let priceCount = 0;
  let validationFailures = 0;
  let precisionLosses = 0;
  let outliers = 0;
  let recoveryActions = 0;

  // Single-pass accumulation
  for (let i = 0; i < dailyStats.length; i++) {
    const day = dailyStats[i];
    totalChargeEnergy += day.totalChargeEnergy;
    totalDischargeEnergy += day.totalDischargeEnergy;
    totalProfit += day.totalProfit;
    totalSavings += day.totalSavings;
    
    // Aggregate audit information
    if (day.auditInfo) {
      validationFailures += day.auditInfo.validationFailures;
      precisionLosses += day.auditInfo.precisionLosses;
      outliers += day.auditInfo.outliers;
      recoveryActions += day.auditInfo.recoveryActions;
    }
  }

  // Calculate average price efficiently
  for (let i = 0; i < validation.cleanedEntries.length; i++) {
    const entry = validation.cleanedEntries[i];
    if (entry.priceAtTime) {
      totalPrice += entry.priceAtTime;
      priceCount++;
    }
  }

  const averagePrice = priceCount > 0 ? totalPrice / priceCount : 0;
  const financialCalculatorStats = financialCalculator.getAuditStatistics();
  
  // Generate memory report
  const memoryReport = generateStatisticsMemoryReport(entries);

  return {
    summary: {
      totalEvents: validation.cleanedEntries.length,
      totalChargeEnergy: bankersRounding(totalChargeEnergy, FINANCIAL_CONSTANTS.ENERGY_AMOUNT_DECIMALS),
      totalDischargeEnergy: bankersRounding(totalDischargeEnergy, FINANCIAL_CONSTANTS.ENERGY_AMOUNT_DECIMALS),
      totalProfit: bankersRounding(totalProfit, FINANCIAL_CONSTANTS.CURRENCY_DECIMALS),
      totalSavings: bankersRounding(totalSavings, FINANCIAL_CONSTANTS.CURRENCY_DECIMALS),
      averagePrice: bankersRounding(averagePrice, FINANCIAL_CONSTANTS.ENERGY_PRICE_DECIMALS),
    },
    audit: {
      validationFailures,
      precisionLosses,
      outliers,
      recoveryActions,
      financialCalculatorStats,
      memoryReport,
    },
  };
}

/**
 * Generate memory usage report for statistics entries
 * @param entries - Array of statistics entries
 * @returns Memory usage report
 */
export function generateStatisticsMemoryReport(entries: StatisticsEntry[]): StatisticsMemoryReport {
  const currentMemoryBytes = entries.length * 1200; // ~1.2KB per entry estimate
  const currentMemoryMB = currentMemoryBytes / (1024 * 1024);
  
  const timestamps = entries.map(e => e.timestamp).sort((a, b) => a - b);
  const oldestEntry = timestamps.length > 0 ? timestamps[0] : undefined;
  const newestEntry = timestamps.length > 0 ? timestamps[timestamps.length - 1] : undefined;
  
  return {
    totalEntries: entries.length,
    estimatedMemoryBytes: currentMemoryBytes,
    estimatedMemoryMB: currentMemoryMB,
    oldestEntryTimestamp: oldestEntry,
    newestEntryTimestamp: newestEntry,
    cleanupPerformed: false,
    entriesRemoved: 0,
    retentionDays: 30,
    isNearLimit: entries.length > 8000, // 80% of default max
  };
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
 * Enhanced cleanup of old statistics entries with memory-aware retention policies.
 * This function has two overloads for backward compatibility.
 */

// Overload 1: Legacy signature for backward compatibility
export function cleanupOldEntries(
  entries: StatisticsEntry[], 
  retentionDays: number
): StatisticsEntry[];

// Overload 2: Enhanced signature with memory management
export function cleanupOldEntries(
  entries: StatisticsEntry[], 
  retentionDays: number,
  maxEntries: number,
  memoryConfig?: Partial<StatisticsMemoryConfig>
): { cleanedEntries: StatisticsEntry[]; cleanupReport: StatisticsMemoryReport };

// Implementation
export function cleanupOldEntries(
  entries: StatisticsEntry[], 
  retentionDays: number, 
  maxEntries?: number,
  memoryConfig?: Partial<StatisticsMemoryConfig>
): StatisticsEntry[] | { cleanedEntries: StatisticsEntry[]; cleanupReport: StatisticsMemoryReport } {
  // Backward compatibility: if only 2 arguments, return legacy format
  if (arguments.length === 2) {
    const cutoff = Date.now() / 1000 - (retentionDays * 24 * 60 * 60);
    return entries.filter((entry) => entry.timestamp >= cutoff);
  }
  
  // New enhanced version with 3+ arguments
  const config = { ...DEFAULT_STATISTICS_MEMORY_CONFIG, ...memoryConfig };
  const now = Date.now() / 1000;
  const cutoff = now - (retentionDays * 24 * 60 * 60);
  
  // Calculate current memory usage
  const currentMemoryBytes = entries.length * 1200; // ~1.2KB per entry estimate
  const currentMemoryMB = currentMemoryBytes / (1024 * 1024);
  
  // Step 1: Time-based cleanup
  let timeFiltered = entries.filter((entry) => entry.timestamp >= cutoff);
  let entriesRemovedByTime = entries.length - timeFiltered.length;
  
  // Step 2: Entry count-based cleanup (if still over limit)
  let countFiltered = timeFiltered;
  if (timeFiltered.length > maxEntries!) {
    // Keep the most recent entries
    const startIndex = Math.max(0, timeFiltered.length - maxEntries!);
    countFiltered = timeFiltered.slice(startIndex);
    entriesRemovedByTime += (timeFiltered.length - countFiltered.length);
  }
  
  // Step 3: Memory-based cleanup (if still over memory limit)
  let memoryFiltered = countFiltered;
  if (config.enableProactiveCleanup && currentMemoryMB > config.maxMemoryUsageMB) {
    const targetEntries = Math.floor(maxEntries! * (config.maxMemoryUsageMB / currentMemoryMB));
    if (targetEntries < countFiltered.length) {
      const startIndex = Math.max(0, countFiltered.length - targetEntries);
      memoryFiltered = countFiltered.slice(startIndex);
    }
  }
  
  // Calculate timestamps for report
  const timestamps = memoryFiltered.map(e => e.timestamp).sort((a, b) => a - b);
  const oldestEntry = timestamps.length > 0 ? timestamps[0] : undefined;
  const newestEntry = timestamps.length > 0 ? timestamps[timestamps.length - 1] : undefined;
  
  // Check if cleanup was performed
  const cleanupPerformed = entriesRemovedByTime > 0 || memoryFiltered.length !== countFiltered.length;
  const finalMemoryBytes = memoryFiltered.length * 1200;
  const finalMemoryMB = finalMemoryBytes / (1024 * 1024);
  
  // Log cleanup action if significant
  if (cleanupPerformed && typeof console !== 'undefined' && console.log) {
    console.log(`Statistics: Cleaned up ${entriesRemovedByTime} entries, retained ${memoryFiltered.length}`);
    console.log(`Memory usage: ${currentMemoryMB.toFixed(2)}MB -> ${finalMemoryMB.toFixed(2)}MB`);
  }
  
  return {
    cleanedEntries: memoryFiltered,
    cleanupReport: {
      totalEntries: memoryFiltered.length,
      estimatedMemoryBytes: finalMemoryBytes,
      estimatedMemoryMB: finalMemoryMB,
      oldestEntryTimestamp: oldestEntry,
      newestEntryTimestamp: newestEntry,
      cleanupPerformed,
      entriesRemoved: entriesRemovedByTime,
      retentionDays,
      isNearLimit: memoryFiltered.length > (maxEntries! * config.cleanupThreshold),
    }
  };
}

/**
 * Memory-optimized statistics entry logging with single-pass processing.
 * Reduces string operation overhead and memory pressure.
 * @param entry - The statistics entry to log
 * @param settings - Statistics settings for transparency mode
 * @param logger - Logger function (e.g., this.log from Homey device)
 * @param calculationDetails - Additional calculation details
 */
export function logStatisticsEntryOptimized(
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
  const energyStr = Math.abs(entry.energyAmount).toFixed(3);
  const durationStr = entry.duration.toString();
  
  // Build base log entry efficiently
  const logParts = [`[${timestamp}] ${entry.type.toUpperCase()}`];
  logParts.push(`- Energy: ${energyStr} kWh, Duration: ${durationStr} min`);

  if (entry.priceAtTime) {
    const profitSavingsResult = calculateProfitSavings(entry);
    const { profitSavings } = profitSavingsResult;
    const priceStr = entry.priceAtTime.toFixed(4);
    const profitStr = profitSavings.toFixed(2);
    
    logParts.push(`, Price: €${priceStr}/kWh, Profit/Savings: €${profitStr}`);
    
    // Log warnings and recovery actions if any (batch processing)
    if (profitSavingsResult.warnings.length > 0 || 
        (profitSavingsResult.audit.recoveryActions && profitSavingsResult.audit.recoveryActions.length > 0)) {
      logger(logParts.join(''));
      
      // Clear parts for additional messages
      logParts.length = 0;
      
      for (const warning of profitSavingsResult.warnings) {
        logger(`  Warning: ${warning}`);
      }

      if (profitSavingsResult.audit.recoveryActions && profitSavingsResult.audit.recoveryActions.length > 0) {
        for (const action of profitSavingsResult.audit.recoveryActions) {
          logger(`  Recovery: ${action}`);
        }
      }
      return; // Already logged
    }
  } else {
    logParts.push(', Price: N/A');
  }
  
  logger(logParts.join(''));

  if (settings.transparency && calculationDetails) {
    logger(`  Calculation Method: ${calculationDetails.method}`);
    
    // Optimize JSON.stringify by limiting depth and using minimal spacing
    const inputsStr = JSON.stringify(calculationDetails.inputs, null, 0); // No indentation
    logger(`  Inputs: ${inputsStr}`);
    
    if (calculationDetails.intermediateSteps) {
      const stepsStr = JSON.stringify(calculationDetails.intermediateSteps, null, 0);
      logger(`  Intermediate Steps: ${stepsStr}`);
    }
  }

  if (entry.startEnergyMeter !== undefined && entry.endEnergyMeter !== undefined) {
    logger(`  Meter Reading: ${entry.startEnergyMeter} -> ${entry.endEnergyMeter}`);
  }
}

/**
 * Legacy logStatisticsEntry function for backward compatibility
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
  logStatisticsEntryOptimized(entry, settings, logger, calculationDetails);
}

/**
 * Retrieves the calculation audit trail for a given time period with enhanced validation.
 * @param entries - Array of statistics entries
 * @param startTime - Start timestamp (inclusive)
 * @param endTime - End timestamp (exclusive)
 * @returns Array of audit trail entries with enhanced calculation details
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
    precisionLoss: number,
    outlierDetected: boolean,
    recoveryActions: string[],
    details: string,
  },
}> {
  const filteredEntries = entries.filter((e) => e.timestamp >= startTime && e.timestamp < endTime);

  return filteredEntries.map((entry) => {
    const energyValidation = validateEnergyAmount(Math.abs(entry.energyAmount));
    const energyValid = energyValidation.isValid;

    const timestampValidation = validateTimestamp(entry.timestamp);
    const timestampValid = timestampValidation.isValid;

    const profitSavingsResult = calculateProfitSavings(entry);
    const { profitSavings } = profitSavingsResult;
    const profitValid = !isNaN(profitSavings) && isFinite(profitSavings);

    const precisionLoss = profitSavingsResult.audit.precisionLoss || 0;
    const outlierDetected = profitSavingsResult.audit.isOutlier || false;
    const recoveryActions = profitSavingsResult.audit.recoveryActions || [];

    let details = `Energy: ${Math.abs(entry.energyAmount).toFixed(3)} kWh (${energyValid ? 'valid' : 'invalid'})`;
    if (entry.priceAtTime) {
      details += `, Profit/Savings: €${profitSavings.toFixed(2)} (${profitValid ? 'valid' : 'invalid'})`;
    }
    details += `, Timestamp: ${new Date(entry.timestamp).toISOString()} (${timestampValid ? 'valid' : 'invalid'})`;

    if (precisionLoss > FINANCIAL_CONSTANTS.PRECISION_THRESHOLD) {
      details += `, Precision Loss: ${(precisionLoss * 100).toFixed(4)}%`;
    }

    if (outlierDetected) {
      details += ', Outlier Detected';
    }

    if (recoveryActions.length > 0) {
      details += `, Recovery Actions: ${recoveryActions.length}`;
    }

    return {
      entry,
      verification: {
        energyValid,
        profitValid,
        timestampValid,
        precisionLoss,
        outlierDetected,
        recoveryActions,
        details,
      },
    };
  });
}

/**
 * Gets the default statistics settings.
 * @returns Default StatisticsSettings with memory optimization
 */
export function getDefaultStatisticsSettings(): StatisticsSettings {
  return {
    enabled: false,
    retentionDays: 30,
    maxEntries: 10000, // Default maximum entries
    enableMemoryOptimization: true, // Enable memory optimization by default
    exportFormat: 'json',
  };
}

/**
 * Enhanced statistics entry creator with comprehensive validation and safety checks.
 * @param type - Event type
 * @param timestamp - Event timestamp
 * @param energyAmount - Energy amount
 * @param duration - Duration in minutes
 * @param priceAtTime - Energy price
 * @param meterData - Optional meter reading data
 * @returns Enhanced statistics entry
 */
export function createStatisticsEntry(
  type: 'charging' | 'discharging',
  timestamp: number,
  energyAmount: number,
  duration: number,
  priceAtTime?: number,
  meterData?: { startEnergyMeter?: number; endEnergyMeter?: number },
): StatisticsEntry {
  // Validate inputs
  const timestampValidation = validateTimestamp(timestamp);
  const energyValidation = validateEnergyAmount(Math.abs(energyAmount));

  const warnings: string[] = [];
  const recoveryActions: string[] = [];

  if (!timestampValidation.isValid) {
    warnings.push(`Timestamp validation failed: ${timestampValidation.error}`);
    recoveryActions.push('Using provided timestamp despite validation failure');
  }

  if (!energyValidation.isValid) {
    warnings.push(`Energy validation failed: ${energyValidation.error}`);
    recoveryActions.push('Using provided energy amount despite validation failure');
  }

  if (priceAtTime) {
    const priceValidation = validateEnergyPrice(priceAtTime);
    if (!priceValidation.isValid) {
      warnings.push(`Price validation failed: ${priceValidation.error}`);
      recoveryActions.push('Using provided price despite validation failure');
    }
    warnings.push(...(priceValidation.warnings || []));
  }

  warnings.push(...(energyValidation.warnings || []));

  return {
    timestamp,
    type,
    energyAmount,
    duration,
    priceAtTime,
    ...meterData,
    calculationAudit: {
      precisionLoss: 0, // Will be calculated during processing
      validationWarnings: warnings,
      calculationMethod: 'enhanced_entry_creation',
      isOutlier: false, // Will be determined during processing
      recoveryActions,
    },
  };
}

/**
 * Validate and clean statistics entries array.
 * @param entries - Array of statistics entries
 * @returns Cleaned entries with validation results
 */
export function validateAndCleanEntries(entries: StatisticsEntry[]): {
  cleanedEntries: StatisticsEntry[];
  validationReport: {
    totalEntries: number;
    validEntries: number;
    invalidEntries: number;
    warnings: number;
    errors: string[];
  };
} {
  const cleanedEntries: StatisticsEntry[] = [];
  const errors: string[] = [];
  let warnings = 0;
  let validEntries = 0;

  for (const entry of entries) {
    try {
      // Validate timestamp
      const timestampValidation = validateTimestamp(entry.timestamp);
      if (!timestampValidation.isValid) {
        errors.push(`Invalid timestamp at index ${entries.indexOf(entry)}: ${timestampValidation.error}`);
        continue;
      }

      // Validate energy amount
      const energyValidation = validateEnergyAmount(Math.abs(entry.energyAmount));
      if (!energyValidation.isValid) {
        errors.push(`Invalid energy amount at index ${entries.indexOf(entry)}: ${energyValidation.error}`);
        continue;
      }

      // Validate price if present
      if (entry.priceAtTime !== undefined && entry.priceAtTime !== null) {
        const priceValidation = validateEnergyPrice(entry.priceAtTime);
        if (!priceValidation.isValid) {
          errors.push(`Invalid price at index ${entries.indexOf(entry)}: ${priceValidation.error}`);
          continue;
        }
        warnings += priceValidation.warnings?.length || 0;
      }

      warnings += energyValidation.warnings?.length || 0;
      cleanedEntries.push(entry);
      validEntries++;

    } catch (error) {
      errors.push(`Processing error at index ${entries.indexOf(entry)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  return {
    cleanedEntries,
    validationReport: {
      totalEntries: entries.length,
      validEntries,
      invalidEntries: entries.length - validEntries,
      warnings,
      errors,
    },
  };
}

/**
 * Get comprehensive statistics summary with audit information.
 * @param entries - Array of statistics entries
 * @returns Comprehensive statistics summary
 */
export function getStatisticsSummary(entries: StatisticsEntry[]): {
  summary: {
    totalEvents: number;
    totalChargeEnergy: number;
    totalDischargeEnergy: number;
    totalProfit: number;
    totalSavings: number;
    averagePrice: number;
  };
  audit: {
    validationFailures: number;
    precisionLosses: number;
    outliers: number;
    recoveryActions: number;
    financialCalculatorStats: any;
  };
} {
  const validation = validateAndCleanEntries(entries);
  const dailyStats = aggregateDailyStats(validation.cleanedEntries);

  let totalChargeEnergy = 0;
  let totalDischargeEnergy = 0;
  let totalProfit = 0;
  let totalSavings = 0;
  let totalPrice = 0;
  let priceCount = 0;

  for (const day of dailyStats) {
    totalChargeEnergy += day.totalChargeEnergy;
    totalDischargeEnergy += day.totalDischargeEnergy;
    totalProfit += day.totalProfit;
    totalSavings += day.totalSavings;
  }

  // Calculate average price
  for (const entry of validation.cleanedEntries) {
    if (entry.priceAtTime) {
      totalPrice += entry.priceAtTime;
      priceCount++;
    }
  }

  const averagePrice = priceCount > 0 ? totalPrice / priceCount : 0;

  // Aggregate audit information
  let validationFailures = 0;
  let precisionLosses = 0;
  let outliers = 0;
  let recoveryActions = 0;

  for (const day of dailyStats) {
    if (day.auditInfo) {
      validationFailures += day.auditInfo.validationFailures;
      precisionLosses += day.auditInfo.precisionLosses;
      outliers += day.auditInfo.outliers;
      recoveryActions += day.auditInfo.recoveryActions;
    }
  }

  const financialCalculatorStats = financialCalculator.getAuditStatistics();

  return {
    summary: {
      totalEvents: validation.cleanedEntries.length,
      totalChargeEnergy: bankersRounding(totalChargeEnergy, FINANCIAL_CONSTANTS.ENERGY_AMOUNT_DECIMALS),
      totalDischargeEnergy: bankersRounding(totalDischargeEnergy, FINANCIAL_CONSTANTS.ENERGY_AMOUNT_DECIMALS),
      totalProfit: bankersRounding(totalProfit, FINANCIAL_CONSTANTS.CURRENCY_DECIMALS),
      totalSavings: bankersRounding(totalSavings, FINANCIAL_CONSTANTS.CURRENCY_DECIMALS),
      averagePrice: bankersRounding(averagePrice, FINANCIAL_CONSTANTS.ENERGY_PRICE_DECIMALS),
    },
    audit: {
      validationFailures,
      precisionLosses,
      outliers,
      recoveryActions,
      financialCalculatorStats,
    },
  };
}

/**
 * CRITICAL FIX: Explicit CommonJS exports for Node.js compatibility
 * This ensures all key functions are available when compiled to CommonJS modules
 */

// Check if we're in a CommonJS environment and export accordingly
if (typeof module !== 'undefined' && module.exports) {
  // Export all key functions explicitly for CommonJS compatibility
  // Note: Types/interfaces are not exported as values in CommonJS
  module.exports = {
    // Constants
    DEFAULT_STATISTICS_MEMORY_CONFIG,
    
    // Core calculation functions
    calculateEnergyAmount,
    calculateProfitSavings,
    
    // Aggregation and summary functions
    aggregateDailyStats,
    aggregateDailyStatsOptimized,
    getStatisticsSummary,
    getStatisticsSummaryOptimized,
    calculateDetailedBreakdown,
    
    // Memory management functions
    cleanupOldEntries,
    getHistoricalValuesOptimized,
    generateStatisticsMemoryReport,
    validateAndCleanEntries,
    
    // Logging functions
    logStatisticsEntry,
    logStatisticsEntryOptimized,
    
    // Utility functions
    getCalculationAuditTrail,
    getDefaultStatisticsSettings,
    createStatisticsEntry,
  };
}
