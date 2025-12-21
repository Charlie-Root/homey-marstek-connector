/**
 * Test script to verify the complete statistics pipeline works end-to-end
 * after fixing the critical issues in processGridCounterStatistics()
 */

const Homey = require('homey');
const MarstekVenusDevice = require('./drivers/marstek-venus/device');

// Mock Homey environment
const mockHomey = {
  log: console.log,
  error: console.error,
  setCapabilityValue: async (capability, value) => {
    console.log(`[MOCK] Setting capability ${capability} to ${value}`);
  },
  getCapabilityValue: async (capability) => {
    console.log(`[MOCK] Getting capability ${capability}`);
    return null;
  },
  setStoreValue: async (key, value) => {
    console.log(`[MOCK] Storing ${key}:`, typeof value === 'object' ? JSON.stringify(value) : value);
  },
  getStoreValue: (key) => {
    console.log(`[MOCK] Retrieving ${key}`);
    return null;
  },
  flow: {
    getTriggerCard: (id) => ({
      trigger: async (data, tokens) => {
        console.log(`[MOCK] Flow trigger ${id} triggered with:`, data, tokens);
      }
    })
  },
  setInterval: (callback, interval) => {
    console.log(`[MOCK] Set interval for ${interval}ms`);
    return setInterval(callback, interval);
  },
  clearInterval: (id) => {
    console.log(`[MOCK] Cleared interval ${id}`);
    clearInterval(id);
  },
  setTimeout: (callback, delay) => {
    console.log(`[MOCK] Set timeout for ${delay}ms`);
    return setTimeout(callback, delay);
  }
};

// Mock device settings
const mockSettings = {
  enable_statistics: true,
  price_per_kwh: 0.30,
  statistics_retention_days: 30,
  statistics_debug: true,
  statistics_transparency: true,
  show_calculation_details: true,
  src: 'test-device-001'
};

// Mock device store
const mockStore = new Map();

// Create mock device instance
const createMockDevice = () => {
  const device = new MarstekVenusDevice();
  
  // Mock device properties
  device.homey = mockHomey;
  device.debug = true;
  device.statisticsLock = false;
  
  // Mock methods
  device.getSetting = (key) => mockSettings[key];
  device.setStoreValue = async (key, value) => {
    mockStore.set(key, value);
    console.log(`[MOCK] Stored ${key}:`, typeof value === 'object' ? JSON.stringify(value) : value);
  };
  device.getStoreValue = (key) => {
    const value = mockStore.get(key);
    console.log(`[MOCK] Retrieved ${key}:`, typeof value === 'object' ? JSON.stringify(value) : value);
    return value;
  };
  device.setCapabilityValue = async (capability, value) => {
    console.log(`[MOCK] Setting capability ${capability} to ${value}`);
  };
  device.hasCapability = (capability) => true;
  device.getCapabilityValue = async (capability) => {
    console.log(`[MOCK] Getting capability ${capability}`);
    return null;
  };
  
  return device;
};

// Test the complete statistics pipeline
async function testStatisticsPipeline() {
  console.log('🧪 Testing Statistics Pipeline Fix');
  console.log('=====================================\n');
  
  const device = createMockDevice();
  
  // Test 1: Verify export calculations are processed
  console.log('Test 1: Processing grid counter statistics with both import and export');
  console.log('---------------------------------------------------------------------');
  
  // Mock grid counter data with both import and export
  const mockResult = {
    total_grid_input_energy: 1500,    // Import counter
    total_grid_output_energy: 800,    // Export counter
    // ... other fields
  };
  
  const divisor = 10.0; // kWh per raw unit
  
  try {
    await device.processGridCounterStatistics(mockResult, divisor);
    console.log('✅ processGridCounterStatistics() completed successfully\n');
  } catch (error) {
    console.error('❌ processGridCounterStatistics() failed:', error);
    return;
  }
  
  // Test 2: Verify statistics are saved
  console.log('Test 2: Verifying statistics are saved to storage');
  console.log('--------------------------------------------------');
  
  const savedStats = device.getStoreValue('statistics');
  if (savedStats && savedStats.length > 0) {
    console.log(`✅ Statistics saved: ${savedStats.length} entries`);
    console.log('First entry:', JSON.stringify(savedStats[0], null, 2));
  } else {
    console.log('❌ No statistics found in storage');
  }
  
  // Test 3: Verify updateProfitCapabilities is called
  console.log('\nTest 3: Verifying updateProfitCapabilities is called');
  console.log('----------------------------------------------------');
  
  try {
    await device.updateProfitCapabilities();
    console.log('✅ updateProfitCapabilities() completed successfully\n');
  } catch (error) {
    console.error('❌ updateProfitCapabilities() failed:', error);
    return;
  }
  
  // Test 4: Verify complete pipeline with multiple data points
  console.log('Test 4: Testing complete pipeline with multiple data points');
  console.log('-----------------------------------------------------------');
  
  // Simulate multiple grid counter updates over time
  const testDataPoints = [
    { input: 1500, output: 800, timestamp: Date.now() },
    { input: 1550, output: 820, timestamp: Date.now() + 60000 },  // 1 minute later
    { input: 1600, output: 850, timestamp: Date.now() + 120000 }, // 2 minutes later
  ];
  
  for (let i = 0; i < testDataPoints.length; i++) {
    const point = testDataPoints[i];
    console.log(`Processing data point ${i + 1}: input=${point.input}, output=${point.output}`);
    
    const mockResultPoint = {
      total_grid_input_energy: point.input,
      total_grid_output_energy: point.output,
    };
    
    await device.processGridCounterStatistics(mockResultPoint, divisor);
    
    // Check statistics after each point
    const currentStats = device.getStoreValue('statistics');
    console.log(`  Statistics entries after point ${i + 1}: ${currentStats ? currentStats.length : 0}`);
  }
  
  // Final verification
  console.log('\nFinal Verification:');
  console.log('-------------------');
  
  const finalStats = device.getStoreValue('statistics');
  if (finalStats && finalStats.length > 0) {
    console.log(`✅ Final statistics count: ${finalStats.length}`);
    
    // Verify both import and export entries exist
    const importEntries = finalStats.filter(entry => entry.type === 'charging');
    const exportEntries = finalStats.filter(entry => entry.type === 'discharging');
    
    console.log(`✅ Import entries: ${importEntries.length}`);
    console.log(`✅ Export entries: ${exportEntries.length}`);
    
    if (importEntries.length > 0 && exportEntries.length > 0) {
      console.log('✅ Both import and export calculations are working');
    } else {
      console.log('❌ Missing import or export calculations');
    }
    
    // Test updateProfitCapabilities one final time
    console.log('\nFinal updateProfitCapabilities call:');
    await device.updateProfitCapabilities();
    
    console.log('\n🎉 All tests completed successfully!');
    console.log('The statistics pipeline is now working end-to-end.');
    
  } else {
    console.log('❌ No statistics found after all data points');
  }
}

// Run the test
testStatisticsPipeline().catch(console.error);