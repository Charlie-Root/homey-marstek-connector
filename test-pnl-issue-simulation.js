/**
 * Comprehensive test to simulate the exact P&L issue scenario
 * This test simulates the scenario where calculations are logged correctly
 * but capability values don't appear in Homey app interface
 */

const fs = require('fs');
const path = require('path');

// Mock Homey device context with enhanced logging
class MockHomeyDevice {
  constructor() {
    this.capabilities = new Map();
    this.logs = [];
    this.statistics = [];
    this.gridCounterState = null;
    this.setCapabilityValueCalls = []; // Track all setCapabilityValue calls
    this.capabilityErrors = []; // Track any errors during capability setting
  }

  log(message, ...args) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message} ${args.join(' ')}`;
    this.logs.push(logEntry);
    console.log(logEntry);
  }

  async setCapabilityValue(capability, value) {
    this.log(`[MOCK] Setting capability ${capability} to ${value}`);
    this.setCapabilityValueCalls.push({
      capability,
      value,
      timestamp: Date.now(),
      success: true
    });
    
    try {
      // Simulate potential Homey capability setting issues
      if (typeof value === 'number' && !isFinite(value)) {
        throw new Error(`Invalid numeric value: ${value}`);
      }
      
      this.capabilities.set(capability, value);
      return Promise.resolve();
    } catch (error) {
      this.capabilityErrors.push({
        capability,
        value,
        error: error.message,
        timestamp: Date.now()
      });
      this.log(`[MOCK] ERROR setting capability ${capability}: ${error.message}`);
      throw error;
    }
  }

  getStoreValue(key) {
    if (key === 'statistics') return this.statistics;
    if (key === 'grid_counter_accumulator') return this.gridCounterState;
    return null;
  }

  setStoreValue(key, value) {
    if (key === 'statistics') this.statistics = value;
    if (key === 'grid_counter_accumulator') this.gridCounterState = value;
    return Promise.resolve();
  }

  getSetting(key) {
    const settings = {
      'enable_statistics': true,
      'price_per_kwh': 0.2499,
      'statistics_debug': true,
      'statistics_transparency': true,
      'show_calculation_details': true,
      'statistics_retention_days': 30,
    };
    return settings[key];
  }

  getCapabilities() {
    return Array.from(this.capabilities.entries());
  }

  getLogs() {
    return this.logs;
  }

  getSetCapabilityValueCalls() {
    return this.setCapabilityValueCalls;
  }

  getCapabilityErrors() {
    return this.capabilityErrors;
  }
}

// Mock the financial calculator with enhanced error handling
const mockFinancialCalculator = {
  calculateEnergyAmount: (type, startMeter, endMeter, divisor, power, timeIntervalHours) => {
    try {
      const energyAmount = (endMeter - startMeter) / divisor;
      return {
        energyAmount,
        audit: {
          inputValues: { type, startMeter, endMeter, divisor, power, timeIntervalHours },
          intermediateSteps: [],
          finalResult: energyAmount,
          precisionLoss: 0,
          validation: { isValid: true, warnings: [] },
          recoveryActions: [],
        }
      };
    } catch (error) {
      return {
        energyAmount: 0,
        audit: {
          inputValues: { type, startMeter, endMeter, divisor, power, timeIntervalHours },
          intermediateSteps: [],
          finalResult: 0,
          precisionLoss: 0,
          validation: { isValid: false, error: error.message },
          recoveryActions: ['Returned zero as safe fallback'],
        }
      };
    }
  },
  
  calculateProfitSavings: (energyAmount, priceAtTime, type) => {
    try {
      const profitSavings = Math.abs(energyAmount) * priceAtTime;
      return {
        profitSavings,
        audit: {
          inputValues: { energyAmount, priceAtTime, type },
          intermediateSteps: [],
          finalResult: profitSavings,
          precisionLoss: 0,
          validation: { isValid: true, warnings: [] },
          recoveryActions: [],
        }
      };
    } catch (error) {
      return {
        profitSavings: 0,
        audit: {
          inputValues: { energyAmount, priceAtTime, type },
          intermediateSteps: [],
          finalResult: 0,
          precisionLoss: 0,
          validation: { isValid: false, error: error.message },
          recoveryActions: ['Returned zero as safe fallback'],
        }
      };
    }
  },
  
  detectOutlier: () => ({ isOutlier: false, zScore: 0 }),
  getAuditStatistics: () => ({}),
};

// Mock statistics utilities with enhanced logging
const mockStatisticsUtils = {
  calculateEnergyAmount: (type, startMeter, endMeter, divisor, power, timeIntervalHours, historicalValues) => {
    try {
      const energyAmount = (endMeter - startMeter) / divisor;
      return {
        energyAmount,
        audit: {},
        warnings: []
      };
    } catch (error) {
      return {
        energyAmount: 0,
        audit: {},
        warnings: [`Calculation failed: ${error.message}`]
      };
    }
  },
  
  calculateProfitSavings: (entry) => {
    try {
      if (entry.priceAtTime == null) {
        return {
          profitSavings: 0,
          audit: {},
          warnings: ['No price data available']
        };
      }
      
      const profitSavings = Math.abs(entry.energyAmount) * entry.priceAtTime;
      return {
        profitSavings,
        audit: {},
        warnings: []
      };
    } catch (error) {
      return {
        profitSavings: 0,
        audit: {},
        warnings: [`Profit calculation failed: ${error.message}`]
      };
    }
  },
  
  aggregateDailyStats: (entries) => {
    const dailyMap = new Map();
    
    for (const entry of entries) {
      const date = new Date(entry.timestamp * 1000).toISOString().split('T')[0];
      let day = dailyMap.get(date);
      if (!day) {
        day = {
          date,
          totalChargeEnergy: 0,
          totalDischargeEnergy: 0,
          totalProfit: 0,
          totalSavings: 0,
          auditInfo: { validationFailures: 0, precisionLosses: 0, outliers: 0, recoveryActions: 0 }
        };
        dailyMap.set(date, day);
      }

      if (entry.type === 'charging') {
        day.totalChargeEnergy += Math.abs(entry.energyAmount);
      } else {
        day.totalDischargeEnergy += Math.abs(entry.energyAmount);
      }

      const profitSavingsResult = mockStatisticsUtils.calculateProfitSavings(entry);
      const { profitSavings } = profitSavingsResult;

      if (entry.type === 'discharging') {
        day.totalSavings += profitSavings;
      }
      day.totalProfit += profitSavings;
    }
    
    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  },
  
  calculateDetailedBreakdown: (entries) => {
    const today = new Date().toISOString().split('T')[0];
    const todayEntries = entries.filter(entry => {
      const entryDate = new Date(entry.timestamp * 1000).toISOString().split('T')[0];
      return entryDate === today;
    });

    let chargeEnergy = 0;
    let dischargeEnergy = 0;
    let savings = 0;
    let cost = 0;

    for (const entry of todayEntries) {
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
  },
  
  cleanupOldEntries: (entries, retentionDays) => {
    const cutoff = Date.now() / 1000 - (retentionDays * 24 * 60 * 60);
    return entries.filter((entry) => entry.timestamp >= cutoff);
  },
  
  logStatisticsEntry: (entry, settings, logger, calculationDetails) => {
    logger(`[${new Date(entry.timestamp * 1000).toISOString()}] ${entry.type.toUpperCase()} - Energy: ${Math.abs(entry.energyAmount).toFixed(3)} kWh, Duration: ${entry.duration} min, Price: €${(entry.priceAtTime || 0).toFixed(4)}/kWh, Profit/Savings: €${(entry.priceAtTime ? Math.abs(entry.energyAmount) * entry.priceAtTime : 0).toFixed(2)}`);
  }
};

// Mock grid counter accumulator
const mockGridCounterAccumulator = {
  updateGridCounterAccumulator: (previousState, sample, options) => {
    const flushIntervalMinutes = options?.flushIntervalMinutes ?? 15;
    const minDeltaTriggerRaw = options?.minDeltaTriggerRaw ?? 10;

    if (!previousState) {
      return { 
        state: {
          divisorRawPerKwh: sample.divisorRawPerKwh,
          lastTimestampSec: sample.timestampSec,
          lastInputRaw: sample.inputRaw,
          lastOutputRaw: sample.outputRaw,
          accStartTimestampSec: sample.timestampSec,
          accStartInputRaw: sample.inputRaw,
          accStartOutputRaw: sample.outputRaw,
          accInputDeltaRaw: 0,
          accOutputDeltaRaw: 0,
        },
        reason: 'initialized'
      };
    }

    if (sample.timestampSec <= previousState.lastTimestampSec) {
      return { state: previousState, reason: 'out_of_order' };
    }

    const deltaInputRaw = sample.inputRaw - previousState.lastInputRaw;
    const deltaOutputRaw = sample.outputRaw - previousState.lastOutputRaw;

    if (deltaInputRaw < 0 || deltaOutputRaw < 0) {
      return { 
        state: {
          divisorRawPerKwh: sample.divisorRawPerKwh,
          lastTimestampSec: sample.timestampSec,
          lastInputRaw: sample.inputRaw,
          lastOutputRaw: sample.outputRaw,
          accStartTimestampSec: sample.timestampSec,
          accStartInputRaw: sample.inputRaw,
          accStartOutputRaw: sample.outputRaw,
          accInputDeltaRaw: 0,
          accOutputDeltaRaw: 0,
        },
        reason: 'counter_reset'
      };
    }

    const nextState = {
      ...previousState,
      lastTimestampSec: sample.timestampSec,
      lastInputRaw: sample.inputRaw,
      lastOutputRaw: sample.outputRaw,
      accInputDeltaRaw: previousState.accInputDeltaRaw + deltaInputRaw,
      accOutputDeltaRaw: previousState.accOutputDeltaRaw + deltaOutputRaw,
    };

    const durationMinutes = (sample.timestampSec - nextState.accStartTimestampSec) / 60;
    const hasMeaningfulDelta = nextState.accInputDeltaRaw >= minDeltaTriggerRaw || nextState.accOutputDeltaRaw >= minDeltaTriggerRaw;
    const shouldFlush = durationMinutes >= flushIntervalMinutes || hasMeaningfulDelta;

    if (!shouldFlush) {
      return { state: nextState, reason: 'no_flush' };
    }

    const flush = {
      startTimestampSec: nextState.accStartTimestampSec,
      endTimestampSec: sample.timestampSec,
      durationMinutes,
      startInputRaw: nextState.accStartInputRaw,
      endInputRaw: nextState.accStartInputRaw + nextState.accInputDeltaRaw,
      deltaInputRaw: nextState.accInputDeltaRaw,
      startOutputRaw: nextState.accStartOutputRaw,
      endOutputRaw: nextState.accStartOutputRaw + nextState.accOutputDeltaRaw,
      deltaOutputRaw: nextState.accOutputDeltaRaw,
      divisorRawPerKwh: nextState.divisorRawPerKwh,
    };

    nextState.accStartTimestampSec = sample.timestampSec;
    nextState.accStartInputRaw = sample.inputRaw;
    nextState.accStartOutputRaw = sample.outputRaw;
    nextState.accInputDeltaRaw = 0;
    nextState.accOutputDeltaRaw = 0;

    return { state: nextState, flush, reason: hasMeaningfulDelta ? 'delta_trigger' : 'time_interval' };
  }
};

// Simulate the exact scenario from the issue
async function simulateIssueScenario() {
  console.log('=== SIMULATING P&L ISSUE SCENARIO ===\n');

  const device = new MockHomeyDevice();
  
  // Simulate the exact scenario: P&L calculations are logged correctly but capabilities don't appear
  console.log('1. Simulating grid counter processing that triggers P&L calculation...\n');
  
  // Simulate grid counter data that would trigger the flush
  const now = Math.floor(Date.now() / 1000);
  
  // First sample (initialization)
  const sample1 = {
    timestampSec: now - 1800, // 30 minutes ago
    inputRaw: 10000,
    outputRaw: 5000,
    divisorRawPerKwh: 10
  };
  
  // Second sample (triggers flush due to delta)
  const sample2 = {
    timestampSec: now - 900, // 15 minutes ago
    inputRaw: 10192, // 19.2 kWh imported
    outputRaw: 5052, // 5.2 kWh exported
    divisorRawPerKwh: 10
  };
  
  // Third sample (current)
  const sample3 = {
    timestampSec: now,
    inputRaw: 10250,
    outputRaw: 5080,
    divisorRawPerKwh: 10
  };

  let state = null;
  
  // Process first sample
  const update1 = mockGridCounterAccumulator.updateGridCounterAccumulator(state, sample1, { flushIntervalMinutes: 15, minDeltaTriggerRaw: 10 });
  console.log(`Sample 1 processed: ${update1.reason}`);
  state = update1.state;
  
  // Process second sample (should trigger flush)
  const update2 = mockGridCounterAccumulator.updateGridCounterAccumulator(state, sample2, { flushIntervalMinutes: 15, minDeltaTriggerRaw: 10 });
  console.log(`Sample 2 processed: ${update2.reason}`);
  
  if (update2.flush) {
    console.log('FLUSH TRIGGERED: TIME_INTERVAL');
    
    // Simulate the exact log message from the issue
    const inputDeltaKwh = update2.flush.deltaInputRaw / update2.flush.divisorRawPerKwh;
    const outputDeltaKwh = update2.flush.deltaOutputRaw / update2.flush.divisorRawPerKwh;
    const durationMinutes = update2.flush.durationMinutes;
    const price = 0.2499;
    
    console.log(`[P&L] Calculated P&L value for charging: -${(inputDeltaKwh * price).toFixed(2)} €`);
    console.log(`[${new Date(update2.flush.endTimestampSec * 1000).toISOString()}] CHARGING- Energy: ${inputDeltaKwh.toFixed(3)} kWh, Duration: ${durationMinutes.toFixed(2)} min, Price: €${price.toFixed(4)}/kWh, Profit/Savings: €${(-inputDeltaKwh * price).toFixed(2)}`);
    
    // Simulate logging the statistics entry
    const entry = {
      timestamp: update2.flush.endTimestampSec,
      type: 'charging',
      energyAmount: -inputDeltaKwh, // Negative for charging
      duration: durationMinutes,
      priceAtTime: price,
      startEnergyMeter: update2.flush.startInputRaw,
      endEnergyMeter: update2.flush.endInputRaw,
      calculationAudit: {
        precisionLoss: 0,
        validationWarnings: [],
        calculationMethod: 'grid_counters_import',
        isOutlier: false,
        recoveryActions: [],
      },
    };
    
    mockStatisticsUtils.logStatisticsEntry(entry, { debug: true, transparency: true }, device.log.bind(device), {
      method: 'grid_counters_import',
      inputs: {
        startTs: update2.flush.startTimestampSec,
        endTs: update2.flush.endTimestampSec,
        startRaw: update2.flush.startInputRaw,
        endRaw: update2.flush.endInputRaw,
        deltaRaw: update2.flush.deltaInputRaw,
        divisorRawPerKwh: update2.flush.divisorRawPerKwh,
      },
    });
    
    // Add to statistics
    device.statistics.push(entry);
  }
  
  state = update2.state;
  
  // Process third sample
  const update3 = mockGridCounterAccumulator.updateGridCounterAccumulator(state, sample3, { flushIntervalMinutes: 15, minDeltaTriggerRaw: 10 });
  console.log(`Sample 3 processed: ${update3.reason}`);
  state = update3.state;
  
  console.log('\n2. Simulating updateProfitCapabilities() call...\n');
  
  // Now simulate the updateProfitCapabilities function call
  console.log('[P&L] updateProfitCapabilities() called - START');
  console.log(`[P&L] Statistics entries count: ${device.statistics.length}`);
  
  if (device.statistics.length === 0) {
    console.log('[P&L] No statistics data available, setting all capabilities to 0');
    // This would be the actual setCapabilityValue calls
    await device.setCapabilityValue('measure_battery_profit_daily', 0);
    await device.setCapabilityValue('measure_battery_profit_hourly', 0);
    await device.setCapabilityValue('measure_battery_charge_energy_daily', 0);
    await device.setCapabilityValue('measure_battery_discharge_energy_daily', 0);
    await device.setCapabilityValue('measure_battery_savings_daily', 0);
    await device.setCapabilityValue('measure_battery_cost_daily', 0);
    await device.setCapabilityValue('measure_battery_net_profit_daily', 0);
    console.log('[P&L] updateProfitCapabilities() completed - END (no data)');
    return;
  }

  console.log('[P&L] Processing statistics data...');
  
  // Test aggregation
  const dailyStats = mockStatisticsUtils.aggregateDailyStats(device.statistics);
  console.log(`[P&L] Daily stats generated, count: ${dailyStats.length}`);
  
  const today = new Date().toISOString().split('T')[0];
  console.log(`[P&L] Today's date: ${today}`);
  
  const todayStat = dailyStats.find((ds) => ds.date === today);
  console.log(`[P&L] Today stat found: ${!!todayStat}`);
  
  const dailyProfit = todayStat ? todayStat.totalProfit : 0;
  console.log(`[P&L] Daily profit calculated: ${dailyProfit} €`);
  
  // Test detailed breakdown
  const breakdown = mockStatisticsUtils.calculateDetailedBreakdown(device.statistics);
  console.log(`[BREAKDOWN] Results: chargeEnergy=${breakdown.chargeEnergy.toFixed(3)} kWh, dischargeEnergy=${breakdown.dischargeEnergy.toFixed(3)} kWh, savings=€${breakdown.savings.toFixed(2)}, cost=€${breakdown.cost.toFixed(2)}, netProfit=€${breakdown.netProfit.toFixed(2)}`);
  
  // Now simulate the actual capability setting calls
  console.log('\n3. Setting capability values...\n');
  
  try {
    // Set daily profit
    console.log(`[P&L] Setting measure_battery_profit_daily to: ${dailyProfit}`);
    await device.setCapabilityValue('measure_battery_profit_daily', dailyProfit);
    console.log('[P&L] measure_battery_profit_daily set successfully');

    // Set hourly profit
    const nowDate = new Date();
    const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    const hoursElapsed = (nowDate.getTime() - startOfDay.getTime()) / (1000 * 60 * 60);
    const hourlyProfit = (hoursElapsed > 0) ? dailyProfit / hoursElapsed : 0;
    console.log(`[P&L] Hourly profit calculated: ${hourlyProfit} €/h`);
    console.log(`[P&L] Setting measure_battery_profit_hourly to: ${hourlyProfit}`);
    await device.setCapabilityValue('measure_battery_profit_hourly', hourlyProfit);
    console.log('[P&L] measure_battery_profit_hourly set successfully');

    // Set detailed breakdown capabilities
    console.log(`[P&L] Setting measure_battery_charge_energy_daily to: ${breakdown.chargeEnergy}`);
    await device.setCapabilityValue('measure_battery_charge_energy_daily', breakdown.chargeEnergy);
    console.log('[P&L] measure_battery_charge_energy_daily set successfully');

    console.log(`[P&L] Setting measure_battery_discharge_energy_daily to: ${breakdown.dischargeEnergy}`);
    await device.setCapabilityValue('measure_battery_discharge_energy_daily', breakdown.dischargeEnergy);
    console.log('[P&L] measure_battery_discharge_energy_daily set successfully');

    console.log(`[P&L] Setting measure_battery_savings_daily to: ${breakdown.savings}`);
    await device.setCapabilityValue('measure_battery_savings_daily', breakdown.savings);
    console.log('[P&L] measure_battery_savings_daily set successfully');

    console.log(`[P&L] Setting measure_battery_cost_daily to: ${breakdown.cost}`);
    await device.setCapabilityValue('measure_battery_cost_daily', breakdown.cost);
    console.log('[P&L] measure_battery_cost_daily set successfully');

    console.log(`[P&L] Setting measure_battery_net_profit_daily to: ${breakdown.netProfit}`);
    await device.setCapabilityValue('measure_battery_net_profit_daily', breakdown.netProfit);
    console.log('[P&L] measure_battery_net_profit_daily set successfully');

    // Set additional capabilities
    const currentPrice = 0.2499;
    console.log(`[P&L] Setting measure_current_energy_price to: ${currentPrice}`);
    await device.setCapabilityValue('measure_current_energy_price', currentPrice);
    console.log('[P&L] measure_current_energy_price set successfully');

    console.log('[P&L] Setting measure_calculation_method to: hybrid');
    await device.setCapabilityValue('measure_calculation_method', 'hybrid');
    console.log('[P&L] measure_calculation_method set successfully');

    const timestamp = Math.floor(Date.now() / 1000);
    console.log(`[P&L] Setting measure_calculation_timestamp to: ${timestamp}`);
    await device.setCapabilityValue('measure_calculation_timestamp', timestamp);
    console.log('[P&L] measure_calculation_timestamp set successfully');

    console.log('\n4. Test completed successfully!\n');
    
  } catch (error) {
    console.error(`[P&L] ERROR in updateProfitCapabilities: ${error.message}`);
  }

  // Analyze results
  console.log('=== ANALYSIS RESULTS ===\n');
  
  console.log('1. Statistics Entries:');
  device.statistics.forEach((entry, index) => {
    console.log(`   Entry ${index + 1}: ${entry.type} - ${Math.abs(entry.energyAmount).toFixed(3)} kWh at €${entry.priceAtTime}/kWh`);
  });
  
  console.log('\n2. Set Capability Value Calls:');
  device.getSetCapabilityValueCalls().forEach((call, index) => {
    console.log(`   Call ${index + 1}: ${call.capability} = ${call.value} (success: ${call.success})`);
  });
  
  console.log('\n3. Final Capability Values:');
  const capabilities = device.getCapabilities();
  capabilities.forEach(([capability, value]) => {
    console.log(`   ${capability}: ${value}`);
  });
  
  console.log('\n4. Capability Errors:');
  const errors = device.getCapabilityErrors();
  if (errors.length === 0) {
    console.log('   No errors detected');
  } else {
    errors.forEach((error, index) => {
      console.log(`   Error ${index + 1}: ${error.capability} = ${error.value} (${error.error})`);
    });
  }
  
  console.log('\n=== POTENTIAL ISSUES IDENTIFIED ===\n');
  
  // Check for potential issues
  const potentialIssues = [];
  
  // Check if any capability values are NaN or Infinity
  capabilities.forEach(([capability, value]) => {
    if (typeof value === 'number' && !isFinite(value)) {
      potentialIssues.push(`Capability ${capability} has invalid value: ${value}`);
    }
  });
  
  // Check if any setCapabilityValue calls failed
  const failedCalls = device.getSetCapabilityValueCalls().filter(call => !call.success);
  if (failedCalls.length > 0) {
    potentialIssues.push(`${failedCalls.length} setCapabilityValue calls failed`);
  }
  
  // Check if statistics aggregation produced valid results
  if (dailyStats.length === 0) {
    potentialIssues.push('No daily stats generated from statistics entries');
  } else {
    const todayStat = dailyStats.find(ds => ds.date === today);
    if (!todayStat) {
      potentialIssues.push('No statistics found for today');
    }
  }
  
  if (potentialIssues.length === 0) {
    console.log('✅ No obvious technical issues found in the simulation.');
    console.log('   The problem might be in the Homey app interface or capability registration.');
    console.log('   Possible causes:');
    console.log('   1. Capabilities not properly registered in app.json');
    console.log('   2. Homey app interface not refreshing capability values');
    console.log('   3. Capability values being overwritten by other processes');
    console.log('   4. Timing issues between calculation and capability setting');
  } else {
    console.log('❌ Potential issues identified:');
    potentialIssues.forEach((issue, index) => {
      console.log(`   ${index + 1}. ${issue}`);
    });
  }
}

// Run the simulation
simulateIssueScenario().catch(console.error);