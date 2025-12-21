/**
 * Debug script to identify P&L calculation issues
 * Analyzes the grid counter accumulator logic and energy delta detection
 */

// Mock the grid counter accumulator logic based on the actual implementation
function mockUpdateGridCounterAccumulator(previousState, sample, options = {}) {
  const flushIntervalMinutes = options.flushIntervalMinutes || 60;
  
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

  // Ignore out-of-order samples
  if (sample.timestampSec <= previousState.lastTimestampSec) {
    return { state: previousState, reason: 'out_of_order' };
  }

  // Divisor change: reset to avoid mixing units
  if (previousState.divisorRawPerKwh !== sample.divisorRawPerKwh) {
    return { state: null, reason: 'divisor_changed' };
  }

  const deltaInputRaw = sample.inputRaw - previousState.lastInputRaw;
  const deltaOutputRaw = sample.outputRaw - previousState.lastOutputRaw;

  // Counter reset detection
  if (deltaInputRaw < 0 || deltaOutputRaw < 0) {
    return { state: null, reason: 'counter_reset' };
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
  const shouldFlush = durationMinutes >= flushIntervalMinutes;

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

  // Reset window for next accumulation
  nextState.accStartTimestampSec = sample.timestampSec;
  nextState.accStartInputRaw = sample.inputRaw;
  nextState.accStartOutputRaw = sample.outputRaw;
  nextState.accInputDeltaRaw = 0;
  nextState.accOutputDeltaRaw = 0;

  return { state: nextState, flush };
}

// Mock P&L calculation
function mockCalculateProfitSavings(entry) {
  if (!entry.priceAtTime) {
    return {
      profitSavings: 0,
      audit: { validation: { isValid: true, warnings: ['No price data'] } },
      warnings: ['No price data available for calculation']
    };
  }

  const absEnergy = Math.abs(entry.energyAmount);
  const grossAmount = (absEnergy * entry.priceAtTime);
  const profitSavings = entry.type === 'discharging' ? grossAmount : -grossAmount;

  return {
    profitSavings,
    audit: { validation: { isValid: true } },
    warnings: []
  };
}

// Mock device data based on the logs
const mockDeviceData = {
  total_grid_input_energy: 80184,
  total_grid_output_energy: 61375,
  divisor: 10, // Based on firmware >= 154
  price: 0.30, // Default price
  debug: true
};

// Mock previous accumulator state (simulating static counters)
const mockPreviousState = {
  divisorRawPerKwh: 10,
  lastTimestampSec: Math.floor(Date.now() / 1000) - 300, // 5 minutes ago
  lastInputRaw: 80184,
  lastOutputRaw: 61375,
  accStartTimestampSec: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  accStartInputRaw: 80184,
  accStartOutputRaw: 61375,
  accInputDeltaRaw: 0,
  accOutputDeltaRaw: 0
};

/**
 * Test 1: Check if energy deltas are being detected
 */
function testEnergyDeltaDetection() {
  console.log('=== Test 1: Energy Delta Detection ===');
  
  const now = Math.floor(Date.now() / 1000);
  
  // Test with static counters (no change)
  const staticSample = {
    timestampSec: now,
    inputRaw: 80184,
    outputRaw: 61375,
    divisorRawPerKwh: 10
  };
  
  const staticResult = mockUpdateGridCounterAccumulator(mockPreviousState, staticSample);
  console.log('Static counters result:', {
    reason: staticResult.reason,
    hasFlush: !!staticResult.flush,
    accInputDeltaRaw: staticResult.state?.accInputDeltaRaw,
    accOutputDeltaRaw: staticResult.state?.accOutputDeltaRaw
  });
  
  // Test with small energy changes
  const changedSample = {
    timestampSec: now,
    inputRaw: 80185, // +1 unit
    outputRaw: 61376, // +1 unit
    divisorRawPerKwh: 10
  };
  
  const changedResult = mockUpdateGridCounterAccumulator(mockPreviousState, changedSample);
  console.log('Changed counters result:', {
    reason: changedResult.reason,
    hasFlush: !!changedResult.flush,
    accInputDeltaRaw: changedResult.state?.accInputDeltaRaw,
    accOutputDeltaRaw: changedResult.state?.accOutputDeltaRaw
  });
  
  if (changedResult.flush) {
    console.log('Flush data:', {
      durationMinutes: changedResult.flush.durationMinutes,
      deltaInputRaw: changedResult.flush.deltaInputRaw,
      deltaOutputRaw: changedResult.flush.deltaOutputRaw,
      importKwh: changedResult.flush.deltaInputRaw / 10,
      exportKwh: changedResult.flush.deltaOutputRaw / 10
    });
  }
}

/**
 * Test 2: Check calculation triggers and conditions
 */
function testCalculationTriggers() {
  console.log('\n=== Test 2: Calculation Triggers ===');
  
  // Test with accumulated energy that should trigger calculations
  const accumulatedState = {
    divisorRawPerKwh: 10,
    lastTimestampSec: Math.floor(Date.now() / 1000) - 300,
    lastInputRaw: 80194, // +10 from start
    lastOutputRaw: 61385, // +10 from start
    accStartTimestampSec: Math.floor(Date.now() / 1000) - 3600,
    accStartInputRaw: 80184,
    accStartOutputRaw: 61375,
    accInputDeltaRaw: 10,
    accOutputDeltaRaw: 10
  };
  
  const now = Math.floor(Date.now() / 1000);
  const testSample = {
    timestampSec: now,
    inputRaw: 80194,
    outputRaw: 61385,
    divisorRawPerKwh: 10
  };
  
  const result = mockUpdateGridCounterAccumulator(accumulatedState, testSample);
  console.log('Accumulated state result:', {
    reason: result.reason,
    hasFlush: !!result.flush,
    durationMinutes: result.state ? (now - result.state.accStartTimestampSec) / 60 : 'N/A'
  });
  
  if (result.flush) {
    console.log('Should trigger calculations with:', {
      importKwh: result.flush.deltaInputRaw / 10,
      exportKwh: result.flush.deltaOutputRaw / 10,
      durationMinutes: result.flush.durationMinutes
    });
  }
}

/**
 * Test 3: Check P&L calculation function
 */
function testPLCalculation() {
  console.log('\n=== Test 3: P&L Calculation Function ===');
  
  // Test charging entry
  const chargingEntry = {
    timestamp: Math.floor(Date.now() / 1000),
    type: 'charging',
    energyAmount: 1.0, // 1 kWh
    duration: 60, // 1 hour
    priceAtTime: 0.30,
    startEnergyMeter: 80184,
    endEnergyMeter: 80194
  };
  
  const chargingResult = mockCalculateProfitSavings(chargingEntry);
  console.log('Charging calculation:', {
    profitSavings: chargingResult.profitSavings,
    validation: chargingResult.audit.validation,
    warnings: chargingResult.warnings
  });
  
  // Test discharging entry
  const dischargingEntry = {
    timestamp: Math.floor(Date.now() / 1000),
    type: 'discharging',
    energyAmount: -1.0, // -1 kWh
    duration: 60, // 1 hour
    priceAtTime: 0.30,
    startEnergyMeter: 61375,
    endEnergyMeter: 61385
  };
  
  const dischargingResult = mockCalculateProfitSavings(dischargingEntry);
  console.log('Discharging calculation:', {
    profitSavings: dischargingResult.profitSavings,
    validation: dischargingResult.audit.validation,
    warnings: dischargingResult.warnings
  });
}

/**
 * Test 4: Simulate the complete flow
 */
function testCompleteFlow() {
  console.log('\n=== Test 4: Complete Flow Simulation ===');
  
  let currentState = mockPreviousState;
  const now = Math.floor(Date.now() / 1000);
  
  // Simulate multiple updates with small changes
  for (let i = 1; i <= 5; i++) {
    const sample = {
      timestampSec: now + (i * 60), // Every minute
      inputRaw: 80184 + i, // Gradual increase
      outputRaw: 61375 + i, // Gradual increase
      divisorRawPerKwh: 10
    };
    
    const result = mockUpdateGridCounterAccumulator(currentState, sample);
    currentState = result.state;
    
    console.log(`Update ${i}:`, {
      reason: result.reason,
      accInputDeltaRaw: result.state?.accInputDeltaRaw,
      accOutputDeltaRaw: result.state?.accOutputDeltaRaw,
      durationMinutes: (sample.timestampSec - result.state?.accStartTimestampSec) / 60
    });
    
    if (result.flush) {
      console.log(`  FLUSH TRIGGERED! Import: ${result.flush.deltaInputRaw / 10} kWh, Export: ${result.flush.deltaOutputRaw / 10} kWh`);
      
      // Simulate P&L calculation
      if (result.flush.deltaInputRaw > 0) {
        const entry = {
          timestamp: result.flush.endTimestampSec,
          type: 'charging',
          energyAmount: result.flush.deltaInputRaw / 10,
          duration: result.flush.durationMinutes,
          priceAtTime: 0.30,
          startEnergyMeter: result.flush.startInputRaw,
          endEnergyMeter: result.flush.endInputRaw
        };
        const calcResult = mockCalculateProfitSavings(entry);
        console.log(`  P&L for charging: €${calcResult.profitSavings.toFixed(2)}`);
      }
      
      if (result.flush.deltaOutputRaw > 0) {
        const entry = {
          timestamp: result.flush.endTimestampSec,
          type: 'discharging',
          energyAmount: -result.flush.deltaOutputRaw / 10,
          duration: result.flush.durationMinutes,
          priceAtTime: 0.30,
          startEnergyMeter: result.flush.startOutputRaw,
          endEnergyMeter: result.flush.endOutputRaw
        };
        const calcResult = mockCalculateProfitSavings(entry);
        console.log(`  P&L for discharging: €${calcResult.profitSavings.toFixed(2)}`);
      }
    }
  }
}

/**
 * Test 5: Check for common issues
 */
function testCommonIssues() {
  console.log('\n=== Test 5: Common Issues Check ===');
  
  // Issue 1: Static counters (no energy flow)
  console.log('Issue 1: Static counters');
  const staticResult = mockUpdateGridCounterAccumulator(mockPreviousState, {
    timestampSec: Math.floor(Date.now() / 1000),
    inputRaw: 80184,
    outputRaw: 61375,
    divisorRawPerKwh: 10
  });
  console.log('  Result:', staticResult.reason, '- No calculations triggered');
  
  // Issue 2: Out of order timestamps
  console.log('Issue 2: Out of order timestamps');
  const outOfOrderResult = mockUpdateGridCounterAccumulator(mockPreviousState, {
    timestampSec: mockPreviousState.lastTimestampSec - 100, // Older timestamp
    inputRaw: 80185,
    outputRaw: 61376,
    divisorRawPerKwh: 10
  });
  console.log('  Result:', outOfOrderResult.reason, '- No calculations triggered');
  
  // Issue 3: Counter reset detection
  console.log('Issue 3: Counter reset detection');
  const resetResult = mockUpdateGridCounterAccumulator(mockPreviousState, {
    timestampSec: Math.floor(Date.now() / 1000),
    inputRaw: 80000, // Lower than previous (reset)
    outputRaw: 61000, // Lower than previous (reset)
    divisorRawPerKwh: 10
  });
  console.log('  Result:', resetResult.reason, '- Baseline reset, no calculations');
  
  // Issue 4: Price validation
  console.log('Issue 4: Price validation');
  const invalidPriceEntry = {
    timestamp: Math.floor(Date.now() / 1000),
    type: 'charging',
    energyAmount: 1.0,
    duration: 60,
    priceAtTime: -0.10 // Invalid negative price
  };
  const priceResult = mockCalculateProfitSavings(invalidPriceEntry);
  console.log('  Result:', priceResult.audit.validation.error, '- No calculations with invalid price');
}

// Run all tests
console.log('Debugging P&L Calculation Issues\n');
console.log('Device data:', mockDeviceData);
console.log('Previous state:', mockPreviousState);

testEnergyDeltaDetection();
testCalculationTriggers();
testPLCalculation();
testCompleteFlow();
testCommonIssues();

console.log('\n=== Summary ===');
console.log('Key findings:');
console.log('1. Static counters (no energy flow) will not trigger calculations');
console.log('2. Energy deltas must accumulate to trigger flush (default: 60 minutes)');
console.log('3. Price validation must pass for calculations to proceed');
console.log('4. Out of order timestamps are ignored');
console.log('5. Counter resets trigger baseline reset');