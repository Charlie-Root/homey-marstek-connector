/* eslint-disable max-classes-per-file */

/**
 * Financial calculation utilities with proper precision, rounding, and safety checks.
 * Provides banker's rounding, zero division protection, and precision loss detection.
 */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  warnings?: string[];
}

export interface CalculationAudit {
  inputValues: Record<string, any>;
  intermediateSteps: Array<{ operation: string; value: number; rounded?: number }>;
  finalResult: number;
  precisionLoss: number;
  validation: ValidationResult;
}

/**
 * Financial calculation constants
 */
export const FINANCIAL_CONSTANTS = {
  CURRENCY_DECIMALS: 2,
  ENERGY_PRICE_DECIMALS: 4,
  ENERGY_AMOUNT_DECIMALS: 3,
  MAX_ENERGY_PRICE: 5.00, // €5.00/kWh maximum reasonable price
  MAX_ENERGY_AMOUNT: 1000, // 1000 kWh maximum per event
  MIN_ENERGY_AMOUNT: 0.00001, // 0.00001 kWh minimum meaningful amount
  PRECISION_THRESHOLD: 1e-10, // Threshold for detecting precision loss
} as const;

/**
 * Memory management configuration
 */
export interface MemoryConfig {
  maxAuditEntries: number; // Maximum audit trail entries
  maxStatisticsEntries: number; // Maximum statistics entries per device
  maxRetentionDays: number; // Maximum retention period
  enableLazyReports: boolean; // Enable lazy report generation
  memoryThresholdMB: number; // Memory threshold for cleanup (MB)
  enableMemoryMonitoring: boolean; // Enable memory monitoring
}

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxAuditEntries: 500, // Reduced to prevent memory issues in Homey
  maxStatisticsEntries: 5000, // Reduced to prevent memory issues in Homey
  maxRetentionDays: 30, // 30 days retention
  enableLazyReports: true, // Enable lazy report generation
  memoryThresholdMB: 50, // Reduced to 50MB for safety in Homey
  enableMemoryMonitoring: false, // DISABLED to prevent crashes
};

/**
 * Memory usage report interface
 */
export interface MemoryUsageReport {
  heapUsed: number; // Heap memory used in bytes
  heapTotal: number; // Total heap memory in bytes
  external: number; // External memory in bytes
  auditTrailSize: number; // Number of audit trail entries
  auditTrailMemory: number; // Estimated audit trail memory
  timestamp: number; // Report timestamp
  cleanupPerformed: boolean; // Whether cleanup was performed
}

/**
 * Memory monitoring system for comprehensive memory usage tracking and alerting
 */
export class MemoryMonitor {
  private static instance: MemoryMonitor;
  private baselineMemory?: MemoryUsageReport;
  private memoryHistory: MemoryUsageReport[] = [];
  private readonly maxHistorySize = 100; // Keep last 100 reports
  private alertsEnabled: boolean = true;
  private alertThresholds = {
    memoryIncreasePercent: 50, // Alert if memory increases by 50%
    heapUsageMB: 150, // Alert if heap usage exceeds 150MB
    auditTrailSize: 1500, // Alert if audit trail exceeds 1500 entries
  };

  /**
   * Get singleton instance
   */
  static getInstance(): MemoryMonitor {
    if (!MemoryMonitor.instance) {
      MemoryMonitor.instance = new MemoryMonitor();
    }
    return MemoryMonitor.instance;
  }

  /**
   * Set baseline memory usage for comparison
   * @param report - Memory usage report to set as baseline
   */
  setBaseline(report: MemoryUsageReport): void {
    this.baselineMemory = { ...report };
    if (typeof console !== 'undefined' && console.log) {
      console.log('Memory Monitor: Baseline established', {
        heapUsedMB: (report.heapUsed / (1024 * 1024)).toFixed(2),
        auditTrailSize: report.auditTrailSize,
      });
    }
  }

  /**
   * Record current memory usage
   * @param report - Current memory usage report
   * @returns Analysis of memory usage changes
   */
  recordMemoryUsage(report: MemoryUsageReport): {
    changeFromBaseline: {
      heapUsedDelta: number;
      heapUsedPercent: number;
      auditTrailDelta: number;
    };
    alerts: string[];
    recommendations: string[];
  } {
    // Add to history
    this.memoryHistory.push({ ...report });
    if (this.memoryHistory.length > this.maxHistorySize) {
      this.memoryHistory.shift();
    }

    const analysis = {
      changeFromBaseline: {
        heapUsedDelta: 0,
        heapUsedPercent: 0,
        auditTrailDelta: 0,
      },
      alerts: [] as string[],
      recommendations: [] as string[],
    };

    if (this.baselineMemory) {
      // Calculate changes from baseline
      analysis.changeFromBaseline.heapUsedDelta = report.heapUsed - this.baselineMemory.heapUsed;
      analysis.changeFromBaseline.heapUsedPercent = this.baselineMemory.heapUsed > 0
        ? ((report.heapUsed - this.baselineMemory.heapUsed) / this.baselineMemory.heapUsed) * 100 : 0;
      analysis.changeFromBaseline.auditTrailDelta = report.auditTrailSize - this.baselineMemory.auditTrailSize;

      // Check for alerts
      const heapUsedMB = report.heapUsed / (1024 * 1024);
      const baselineHeapMB = this.baselineMemory.heapUsed / (1024 * 1024);

      if (this.alertsEnabled) {
        if (analysis.changeFromBaseline.heapUsedPercent > this.alertThresholds.memoryIncreasePercent) {
          analysis.alerts.push(
            `Memory usage increased by ${analysis.changeFromBaseline.heapUsedPercent.toFixed(1)}% from baseline`,
          );
        }

        if (heapUsedMB > this.alertThresholds.heapUsageMB) {
          analysis.alerts.push(`Heap usage (${heapUsedMB.toFixed(1)}MB) exceeds threshold (${this.alertThresholds.heapUsageMB}MB)`);
        }

        if (report.auditTrailSize > this.alertThresholds.auditTrailSize) {
          analysis.alerts.push(`Audit trail size (${report.auditTrailSize}) exceeds threshold (${this.alertThresholds.auditTrailSize})`);
        }
      }

      // Generate recommendations
      if (analysis.changeFromBaseline.heapUsedPercent > 30) {
        analysis.recommendations.push('Consider triggering proactive memory cleanup');
      }

      if (report.auditTrailSize > 1200) {
        analysis.recommendations.push('Audit trail is approaching size limit - cleanup recommended');
      }

      if (heapUsedMB > baselineHeapMB * 2) {
        analysis.recommendations.push('Memory usage has doubled - investigate memory leaks');
      }
    }

    // Log alerts if any
    if (analysis.alerts.length > 0 && typeof console !== 'undefined' && console.warn) {
      console.warn('Memory Monitor Alerts:', analysis.alerts);
    }

    return analysis;
  }

  /**
   * Get memory usage history
   * @param count - Number of recent reports to return
   * @returns Array of memory usage reports
   */
  getMemoryHistory(count: number = 10): MemoryUsageReport[] {
    const start = Math.max(0, this.memoryHistory.length - count);
    return this.memoryHistory.slice(start);
  }

  /**
   * Get memory usage statistics
   * @returns Memory usage statistics
   */
  getMemoryStatistics(): {
    baselineEstablished: boolean;
    currentUsage: MemoryUsageReport | null;
    peakUsage: MemoryUsageReport | null;
    averageHeapUsed: number;
    trend: 'increasing' | 'decreasing' | 'stable';
    } {
    if (this.memoryHistory.length === 0) {
      return {
        baselineEstablished: !!this.baselineMemory,
        currentUsage: null,
        peakUsage: null,
        averageHeapUsed: 0,
        trend: 'stable',
      };
    }

    const current = this.memoryHistory[this.memoryHistory.length - 1];
    const peak = this.memoryHistory.reduce((max, report) => (report.heapUsed > max.heapUsed ? report : max));

    const recent = this.memoryHistory.slice(-5);
    const averageHeapUsed = recent.reduce((sum, report) => sum + report.heapUsed, 0) / recent.length;

    // Determine trend
    let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (recent.length >= 3) {
      const first = recent[0].heapUsed;
      const last = recent[recent.length - 1].heapUsed;
      const changePercent = ((last - first) / first) * 100;

      if (changePercent > 5) {
        trend = 'increasing';
      } else if (changePercent < -5) {
        trend = 'decreasing';
      }
    }

    return {
      baselineEstablished: !!this.baselineMemory,
      currentUsage: { ...current },
      peakUsage: { ...peak },
      averageHeapUsed,
      trend,
    };
  }

  /**
   * Configure alert thresholds
   * @param thresholds - New alert thresholds
   */
  configureAlerts(thresholds: Partial<typeof this.alertThresholds>): void {
    this.alertThresholds = { ...this.alertThresholds, ...thresholds };
  }

  /**
   * Enable or disable alerts
   * @param enabled - Whether to enable alerts
   */
  setAlertsEnabled(enabled: boolean): void {
    this.alertsEnabled = enabled;
  }

  /**
   * Force cleanup and get report
   * @param financialCalculator - Financial calculator instance to check
   * @returns Cleanup report
   */
  forceCleanup(financialCalculator: FinancialCalculator): {
    cleanupPerformed: boolean;
    memoryBefore: MemoryUsageReport;
    memoryAfter: MemoryUsageReport;
    entriesRemoved: number;
  } {
    const memoryBefore = financialCalculator.getMemoryUsageReport();
    const cleanupPerformed = financialCalculator.shouldCleanupMemory();

    if (cleanupPerformed) {
      // Trigger cleanup through the financial calculator
      (financialCalculator as any).performMemoryCleanup(true);
    }

    const memoryAfter = financialCalculator.getMemoryUsageReport();

    return {
      cleanupPerformed,
      memoryBefore,
      memoryAfter,
      entriesRemoved: memoryBefore.auditTrailSize - memoryAfter.auditTrailSize,
    };
  }
}

/**
 * Banker's rounding implementation (round half to even)
 * @param value - Number to round
 * @param decimals - Number of decimal places
 * @returns Rounded number
 */
export function bankersRounding(value: number, decimals: number = 2): number {
  if (!isFinite(value) || isNaN(value)) {
    throw new Error(`Invalid value for rounding: ${value}`);
  }

  const factor = 10 ** decimals;
  const scaledValue = value * factor;

  // Check for extremely large numbers that might cause issues
  if (Math.abs(scaledValue) > Number.MAX_SAFE_INTEGER / factor) {
    throw new Error(`Value too large for safe rounding: ${value}`);
  }

  const floorValue = Math.floor(scaledValue);
  const diff = scaledValue - floorValue;

  // Handle exact .5 cases with banker's rounding
  if (Math.abs(diff - 0.5) < FINANCIAL_CONSTANTS.PRECISION_THRESHOLD) {
    // Round to even
    return (floorValue % 2 === 0 ? floorValue : floorValue + 1) / factor;
  }

  // Normal rounding
  return Math.round(scaledValue) / factor;
}

/**
 * Safe division with zero protection and precision control
 * @param numerator - Numerator value
 * @param denominator - Denominator value
 * @param defaultValue - Default value if division is not possible
 * @param decimals - Number of decimal places for result
 * @returns Safe division result
 */
export function safeDivide(
  numerator: number,
  denominator: number,
  defaultValue: number = 0,
  decimals: number = FINANCIAL_CONSTANTS.CURRENCY_DECIMALS,
): number {
  // Input validation
  if (!isFinite(numerator) || isNaN(numerator)) {
    return defaultValue;
  }

  if (!isFinite(denominator) || isNaN(denominator)) {
    return defaultValue;
  }

  // Zero division protection
  if (Math.abs(denominator) < FINANCIAL_CONSTANTS.PRECISION_THRESHOLD) {
    return defaultValue;
  }

  const result = numerator / denominator;

  // Check for overflow
  if (!isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
    return defaultValue;
  }

  // Apply banker's rounding for consistency
  return bankersRounding(result, decimals);
}

/**
 * Validate energy amount input
 * @param energyAmount - Energy amount to validate
 * @returns Validation result
 */
export function validateEnergyAmount(energyAmount: number): ValidationResult {
  const warnings: string[] = [];

  if (!isFinite(energyAmount) || isNaN(energyAmount)) {
    return {
      isValid: false,
      error: 'Energy amount must be a valid number',
    };
  }

  if (energyAmount === 0) {
    return {
      isValid: false,
      error: 'Energy amount cannot be zero',
    };
  }

  if (Math.abs(energyAmount) < FINANCIAL_CONSTANTS.MIN_ENERGY_AMOUNT) {
    warnings.push(`Energy amount very small: ${energyAmount} kWh`);
  }

  if (Math.abs(energyAmount) > FINANCIAL_CONSTANTS.MAX_ENERGY_AMOUNT) {
    return {
      isValid: false,
      error: `Energy amount exceeds maximum: ${energyAmount} kWh > ${FINANCIAL_CONSTANTS.MAX_ENERGY_AMOUNT} kWh`,
    };
  }

  return {
    isValid: true,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Validate energy price input
 * @param price - Energy price to validate
 * @returns Validation result
 */
export function validateEnergyPrice(price: number): ValidationResult {
  const warnings: string[] = [];

  if (!isFinite(price) || isNaN(price)) {
    return {
      isValid: false,
      error: 'Energy price must be a valid number',
    };
  }

  if (price < 0) {
    return {
      isValid: false,
      error: 'Energy price cannot be negative',
    };
  }

  if (price > FINANCIAL_CONSTANTS.MAX_ENERGY_PRICE) {
    warnings.push(`Energy price very high: €${price}/kWh > €${FINANCIAL_CONSTANTS.MAX_ENERGY_PRICE}/kWh`);
  }

  if (price === 0) {
    warnings.push('Energy price is zero - calculations will show zero cost/savings');
  }

  return {
    isValid: true,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Validate timestamp input
 * @param timestamp - Timestamp to validate (Unix timestamp in seconds)
 * @returns Validation result
 */
export function validateTimestamp(timestamp: number): ValidationResult {
  const now = Date.now() / 1000;

  if (!isFinite(timestamp) || isNaN(timestamp)) {
    return {
      isValid: false,
      error: 'Timestamp must be a valid number',
    };
  }

  if (timestamp <= 0) {
    return {
      isValid: false,
      error: 'Timestamp must be positive',
    };
  }

  if (timestamp > now + 300) { // Allow 5 minutes clock skew
    return {
      isValid: false,
      error: 'Timestamp cannot be in the future',
    };
  }

  // Check for very old timestamps (more than 1 year)
  if (timestamp < now - (365 * 24 * 60 * 60)) {
    return {
      isValid: false,
      error: 'Timestamp is too old (over 1 year)',
    };
  }

  return { isValid: true };
}

/**
 * Detect precision loss in calculations
 * @param originalValue - Original value before operations
 * @param calculatedValue - Calculated value after operations
 * @param tolerance - Tolerance for precision loss detection
 * @returns Precision loss information
 */
export function detectPrecisionLoss(
  originalValue: number,
  calculatedValue: number,
  tolerance: number = FINANCIAL_CONSTANTS.PRECISION_THRESHOLD,
): number {
  if (!isFinite(originalValue) || !isFinite(calculatedValue)) {
    return 0;
  }

  const relativeError = Math.abs((calculatedValue - originalValue) / originalValue);
  return relativeError > tolerance ? relativeError : 0;
}

/**
 * Financial Calculator class with comprehensive safety features and memory optimization
 */
export class FinancialCalculator {
  private auditTrail: CalculationAudit[] = [];
  private memoryConfig: MemoryConfig;
  private lastMemoryCheck: number = 0;
  private readonly MEMORY_CHECK_INTERVAL = 60000; // Check memory every minute
  private memoryMonitor: MemoryMonitor;
  private readonly MAX_AUDIT_TRAIL_SIZE = 500; // Conservative limit to prevent memory issues

  /**
   * Create a new FinancialCalculator with configurable memory limits
   * @param memoryConfig - Memory management configuration
   */
  constructor(memoryConfig?: Partial<MemoryConfig>) {
    this.memoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...memoryConfig };
    this.memoryMonitor = MemoryMonitor.getInstance();

    // CRITICAL FIX: Disable memory monitoring that crashes in Homey
    this.memoryConfig.enableMemoryMonitoring = false;

    // Establish baseline after a short delay to ensure system is stable
    setTimeout(() => {
      const baseline = this.getMemoryUsageReport();
      this.memoryMonitor.setBaseline(baseline);
    }, 5000);
  }

  /**
   * Update memory configuration
   * @param newConfig - New memory configuration
   */
  updateMemoryConfig(newConfig: Partial<MemoryConfig>): void {
    this.memoryConfig = { ...this.memoryConfig, ...newConfig };
    // Trigger immediate cleanup if new limits are more restrictive
    this.performMemoryCleanup(true);
  }

  /**
   * Check current memory usage and perform cleanup if needed
   * @param forceCleanup - Force cleanup regardless of interval
   * @returns Whether cleanup was performed
   */
  private performMemoryCleanup(forceCleanup: boolean = false): boolean {
    const now = Date.now();
    let cleanupPerformed = false;

    // CRITICAL FIX: Use ring buffer approach to prevent unbounded growth
    // Always enforce the maximum audit trail size
    if (this.auditTrail.length >= this.MAX_AUDIT_TRAIL_SIZE) {
      // Keep only the most recent entries (ring buffer behavior)
      this.auditTrail = this.auditTrail.slice(-this.MAX_AUDIT_TRAIL_SIZE + 50);

      cleanupPerformed = true;

      // Log cleanup action (throttled to avoid spam)
      // if (typeof console !== 'undefined' && console.log && removedCount > 10) {
      //  console.log(`FinancialCalculator: Cleaned up ${removedCount} audit trail entries (max: ${this.MAX_AUDIT_TRAIL_SIZE})`);
      // }
    }

    // Additional interval-based cleanup for memory pressure (disabled in Homey environment)
    if (!forceCleanup && (now - this.lastMemoryCheck) < this.MEMORY_CHECK_INTERVAL) {
      return cleanupPerformed;
    }

    this.lastMemoryCheck = now;

    // CRITICAL FIX: Disabled memory threshold checking in Homey environment
    // to prevent crashes from process.memoryUsage() calls

    return cleanupPerformed;
  }

  /**
   * Get current memory usage report
   * @returns Memory usage report
   */
  getMemoryUsageReport(): MemoryUsageReport {
    // CRITICAL FIX: Use safe memory estimation instead of process.memoryUsage()
    // process.memoryUsage() crashes in Homey environment with 'uv_resident_set_memory' error
    const auditTrailMemory = this.auditTrail.length * 1500; // ~1.5KB per entry estimate
    const estimatedHeapUsed = Math.min(auditTrailMemory + 5000000, 50000000); // Estimate 5MB base + audit trail, max 50MB

    const report = {
      heapUsed: estimatedHeapUsed,
      heapTotal: Math.min(estimatedHeapUsed * 1.5, 75000000), // Estimate 1.5x heap usage
      external: 0, // Cannot reliably estimate external memory
      auditTrailSize: this.auditTrail.length,
      auditTrailMemory,
      timestamp: Date.now(),
      cleanupPerformed: false, // Will be set by performMemoryCleanup
    };

    // Automatically record memory usage if monitoring is enabled
    if (this.memoryConfig.enableMemoryMonitoring) {
      this.memoryMonitor.recordMemoryUsage(report);
    }

    return report;
  }

  /**
   * Check if memory cleanup should be performed
   * @returns True if cleanup should be performed
   */
  shouldCleanupMemory(): boolean {
    // CRITICAL FIX: Use conservative limits to prevent memory issues in Homey
    // Only check audit trail size, not heap memory (to avoid crashes)
    return this.auditTrail.length > this.MAX_AUDIT_TRAIL_SIZE * 0.8; // Trigger at 80% capacity
  }

  /**
   * Calculate energy amount with comprehensive safety checks
   * @param type - 'charging' or 'discharging'
   * @param startMeter - Starting meter value (local driver)
   * @param endMeter - Ending meter value (local driver)
   * @param divisor - Divisor for meter scaling
   * @param power - Power in W (cloud driver)
   * @param timeIntervalHours - Time interval in hours
   * @returns Energy amount with audit trail
   */
  calculateEnergyAmount(
    type: 'charging' | 'discharging',
    startMeter?: number,
    endMeter?: number,
    divisor?: number,
    power?: number,
    timeIntervalHours?: number,
  ): { energyAmount: number; audit: CalculationAudit } {
    const audit: CalculationAudit = {
      inputValues: {
        type,
        startMeter,
        endMeter,
        divisor,
        power,
        timeIntervalHours,
      },
      intermediateSteps: [],
      finalResult: 0,
      precisionLoss: 0,
      validation: { isValid: true },
    };

    let energyAmount = 0;

    try {
      if (startMeter !== undefined && endMeter !== undefined && divisor !== undefined) {
        // Local driver calculation
        const delta = type === 'charging' ? endMeter - startMeter : startMeter - endMeter;

        // Validate inputs
        const deltaValidation = validateEnergyAmount(Math.abs(delta));
        if (!deltaValidation.isValid) {
          audit.validation = deltaValidation;
          return { energyAmount: 0, audit };
        }

        // Safe division with zero protection
        energyAmount = safeDivide(delta, divisor, 0, FINANCIAL_CONSTANTS.ENERGY_AMOUNT_DECIMALS);

        audit.intermediateSteps.push({
          operation: 'delta_calculation',
          value: delta,
        });
        audit.intermediateSteps.push({
          operation: 'energy_amount',
          value: energyAmount,
        });

      } else if (power !== undefined && timeIntervalHours !== undefined) {
        // Cloud driver calculation

        // Validate inputs
        const powerValidation = validateEnergyAmount(Math.abs(power));
        const timeValidation = validateEnergyAmount(Math.abs(timeIntervalHours));

        if (!powerValidation.isValid || !timeValidation.isValid) {
          audit.validation = !powerValidation.isValid ? powerValidation : timeValidation;
          return { energyAmount: 0, audit };
        }

        // Calculate energy: (power / 1000) * timeIntervalHours
        const powerKw = safeDivide(power, 1000, 0, FINANCIAL_CONSTANTS.ENERGY_AMOUNT_DECIMALS);
        energyAmount = safeDivide(powerKw * timeIntervalHours, 1, 0, FINANCIAL_CONSTANTS.ENERGY_AMOUNT_DECIMALS);

        audit.intermediateSteps.push({
          operation: 'power_kw',
          value: powerKw,
        });
        audit.intermediateSteps.push({
          operation: 'energy_amount',
          value: energyAmount,
        });
      }

      // Validate final result
      const finalValidation = validateEnergyAmount(Math.abs(energyAmount));
      audit.validation = finalValidation;
      audit.finalResult = energyAmount;

      // Detect precision loss
      const expectedSign = type === 'charging' ? 1 : -1;
      const signedEnergyAmount = energyAmount * expectedSign;
      audit.precisionLoss = detectPrecisionLoss(energyAmount, Math.abs(signedEnergyAmount));

    } catch (error) {
      audit.validation = {
        isValid: false,
        error: `Calculation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
      energyAmount = 0;
    }

    this.auditTrail.push(audit);

    // CRITICAL: Always check if memory cleanup is needed after adding audit entry
    if (this.shouldCleanupMemory()) {
      this.performMemoryCleanup(true); // Force cleanup if needed
    }

    return { energyAmount, audit };
  }

  /**
   * Calculate profit/savings with comprehensive safety checks
   * @param energyAmount - Energy amount in kWh
   * @param priceAtTime - Energy price in €/kWh
   * @param type - 'charging' or 'discharging'
   * @returns Profit/savings with audit trail
   */
  calculateProfitSavings(
    energyAmount: number,
    priceAtTime: number,
    type: 'charging' | 'discharging',
  ): { profitSavings: number; audit: CalculationAudit } {
    const audit: CalculationAudit = {
      inputValues: {
        energyAmount,
        priceAtTime,
        type,
      },
      intermediateSteps: [],
      finalResult: 0,
      precisionLoss: 0,
      validation: { isValid: true },
    };

    let profitSavings = 0;

    try {

      // Validate inputs
      const energyValidation = validateEnergyAmount(Math.abs(energyAmount));
      const priceValidation = validateEnergyPrice(priceAtTime);

      if (!energyValidation.isValid) {
        audit.validation = energyValidation;
        return { profitSavings: 0, audit };
      }

      if (!priceValidation.isValid) {
        audit.validation = priceValidation;
        return { profitSavings: 0, audit };
      }

      // Calculate using banker's rounding for currency
      const absEnergy = Math.abs(energyAmount);
      const grossAmount = safeDivide(absEnergy * priceAtTime, 1, 0, FINANCIAL_CONSTANTS.CURRENCY_DECIMALS);

      profitSavings = type === 'discharging' ? grossAmount : -grossAmount;

      audit.intermediateSteps.push({
        operation: 'gross_amount',
        value: grossAmount,
      });
      audit.intermediateSteps.push({
        operation: 'signed_result',
        value: profitSavings,
      });

      audit.finalResult = profitSavings;
      audit.validation.warnings = [
        ...(energyValidation.warnings || []),
        ...(priceValidation.warnings || []),
      ];

    } catch (error) {
      audit.validation = {
        isValid: false,
        error: `Profit/savings calculation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };

    }

    this.auditTrail.push(audit);

    // CRITICAL: Always check if memory cleanup is needed after adding audit entry
    if (this.shouldCleanupMemory()) {
      this.performMemoryCleanup(true); // Force cleanup if needed
    }

    return { profitSavings, audit };
  }

  /**
   * Detect outliers in energy readings
   * @param currentValue - Current energy reading
   * @param historicalValues - Array of historical values for comparison
   * @param threshold - Threshold for outlier detection (standard deviations)
   * @returns Outlier detection result
   */
  detectOutlier(
    currentValue: number,
    historicalValues: number[],
    threshold: number = 2.5,
  ): { isOutlier: boolean; zScore: number; mean: number; stdDev: number } {
    if (historicalValues.length < 3) {
      return {
        isOutlier: false, zScore: 0, mean: currentValue, stdDev: 0,
      };
    }

    const mean = historicalValues.reduce((sum, val) => sum + val, 0) / historicalValues.length;
    const variance = historicalValues.reduce((sum, val) => sum + (val - mean) ** 2, 0) / historicalValues.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) {
      return {
        isOutlier: false, zScore: 0, mean, stdDev,
      };
    }

    const zScore = Math.abs((currentValue - mean) / stdDev);
    const isOutlier = zScore > threshold;

    return {
      isOutlier, zScore, mean, stdDev,
    };
  }

  /**
   * Clear audit trail
   */
  clearAuditTrail(): void {
    this.auditTrail = [];
  }

  /**
   * Get memory monitoring statistics
   * @returns Memory monitoring statistics
   */
  getMemoryMonitoringStats(): ReturnType<MemoryMonitor['getMemoryStatistics']> {
    return this.memoryMonitor.getMemoryStatistics();
  }

  /**
   * Get memory usage history
   * @param count - Number of recent reports to return
   * @returns Array of memory usage reports
   */
  getMemoryHistory(count: number = 10): MemoryUsageReport[] {
    return this.memoryMonitor.getMemoryHistory(count);
  }

  /**
   * Force memory cleanup and get detailed report
   * @returns Detailed cleanup report
   */
  forceMemoryCleanup(): {
    cleanupPerformed: boolean;
    memoryBefore: MemoryUsageReport;
    memoryAfter: MemoryUsageReport;
    entriesRemoved: number;
    analysis: ReturnType<MemoryMonitor['recordMemoryUsage']>;
    } {
    const memoryBefore = this.getMemoryUsageReport();
    const cleanupPerformed = this.performMemoryCleanup(true);
    const memoryAfter = this.getMemoryUsageReport();
    const analysis = this.memoryMonitor.recordMemoryUsage(memoryAfter);

    return {
      cleanupPerformed,
      memoryBefore,
      memoryAfter,
      entriesRemoved: memoryBefore.auditTrailSize - memoryAfter.auditTrailSize,
      analysis,
    };
  }

  /**
   * Configure memory monitoring
   * @param config - Memory configuration updates
   */
  configureMemoryMonitoring(config: Partial<MemoryConfig>): void {
    this.memoryConfig = { ...this.memoryConfig, ...config };

    // Update memory monitor alerts if needed
    if (config.memoryThresholdMB) {
      this.memoryMonitor.configureAlerts({
        heapUsageMB: config.memoryThresholdMB,
      });
    }
  }

  /**
   * Get audit trail for debugging and verification
   * @returns Array of calculation audits (memory-optimized access)
   */
  getAuditTrail(): CalculationAudit[] {
    // Return a reference to the internal array to avoid unnecessary copying
    // Consumers should treat this as read-only
    return this.auditTrail;
  }

  /**
   * Get a limited view of the audit trail to reduce memory pressure
   * @param maxEntries - Maximum number of entries to return
   * @returns Limited array of calculation audits
   */
  getAuditTrailLimited(maxEntries: number = 100): CalculationAudit[] {
    const startIndex = Math.max(0, this.auditTrail.length - maxEntries);
    return this.auditTrail.slice(startIndex);
  }

  /**
   * Get audit trail statistics with memory information
   * @returns Enhanced audit trail statistics
   */
  getAuditStatistics(): {
    totalCalculations: number;
    failedValidations: number;
    precisionLosses: number;
    warnings: number;
    memoryUsage: {
      auditTrailSize: number;
      estimatedMemoryBytes: number;
      isNearLimit: boolean;
    };
    } {
    const stats = {
      totalCalculations: this.auditTrail.length,
      failedValidations: 0,
      precisionLosses: 0,
      warnings: 0,
      memoryUsage: {
        auditTrailSize: this.auditTrail.length,
        estimatedMemoryBytes: this.auditTrail.length * 1500, // ~1.5KB per entry
        isNearLimit: this.auditTrail.length > (this.memoryConfig.maxAuditEntries * 0.8),
      },
    };

    for (const audit of this.auditTrail) {
      if (!audit.validation.isValid) {
        stats.failedValidations++;
      }
      if (audit.precisionLoss > FINANCIAL_CONSTANTS.PRECISION_THRESHOLD) {
        stats.precisionLosses++;
      }
      if (audit.validation.warnings && audit.validation.warnings.length > 0) {
        stats.warnings += audit.validation.warnings.length;
      }
    }

    return stats;
  }
}

// Export singleton instance for common use with optimized memory settings
export const financialCalculator = new FinancialCalculator({
  maxAuditEntries: 500, // Reduced from 1000 to prevent memory issues
  maxStatisticsEntries: 5000, // Reduced from 10000 to prevent memory issues
  maxRetentionDays: 30, // 30 days retention
  enableLazyReports: true, // Enable lazy report generation
  memoryThresholdMB: 50, // Reduced from 100MB to 50MB for safety
  enableMemoryMonitoring: false, // DISABLED to prevent crashes in Homey
});

/**
 * CRITICAL FIX: Explicit CommonJS exports for Node.js compatibility
 * This ensures all key functions are available when compiled to CommonJS modules
 */

// Check if we're in a CommonJS environment and export accordingly
if (typeof module !== 'undefined' && module.exports) {
  // Export all key functions and classes explicitly for CommonJS compatibility
  // Note: Types/interfaces are not exported as values in CommonJS
  module.exports = {
    // Constants
    DEFAULT_MEMORY_CONFIG,
    FINANCIAL_CONSTANTS,

    // Core classes
    MemoryMonitor,
    FinancialCalculator,

    // Core functions
    bankersRounding,
    safeDivide,
    validateEnergyAmount,
    validateEnergyPrice,
    validateTimestamp,
    detectPrecisionLoss,

    // Singleton instance
    financialCalculator,
  };
}
