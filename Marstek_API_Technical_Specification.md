# Marstek Device Open API - Technical Specification

## Complete API Reference

### 1. Marstek Component

#### 1.1 Marstek.GetDevice
**Purpose**: Device discovery and identification on local network

**Request Format**:
```json
{
  "id": 0,
  "method": "Marstek.GetDevice",
  "params": {
    "ble_mac": "string"
  }
}
```

**Parameters**:
- `id`: number (Message identifier, 16-bit integer)
- `method`: "Marstek.GetDevice" (Fixed string)
- `params.ble_mac`: string (Valid MAC address for specific device, "0" for broadcast)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "device": "string",
    "ver": number,
    "ble_mac": "string",
    "wifi_mac": "string",
    "wifi_name": "string",
    "ip": "string"
  }
}
```

**Response Fields**:
- `id`: number (Echoed from request)
- `src`: string (Device identifier, format: "Model-MAC")
- `result.device`: string (Device model name, e.g., "VenusC")
- `result.ver`: number (Firmware version, e.g., 111)
- `result.ble_mac`: string (Bluetooth MAC address)
- `result.wifi_mac`: string (WiFi MAC address)
- `result.wifi_name`: string (WiFi SSID)
- `result.ip`: string (Device IP address)

**Usage Notes**:
- Broadcast discovery: Use `ble_mac: "0"` to discover all devices
- Specific device: Use actual MAC address to target specific device
- Response includes device model for feature detection
- Used for initial device pairing and identification

**Example Request**:
```json
{
  "id": 1,
  "method": "Marstek.GetDevice",
  "params": {
    "ble_mac": "0"
  }
}
```

**Example Response**:
```json
{
  "id": 1,
  "src": "VenusC-123456789012",
  "result": {
    "device": "VenusC",
    "ver": 111,
    "ble_mac": "123456789012",
    "wifi_mac": "012123456789",
    "wifi_name": "MY_HOME",
    "ip": "192.168.1.11"
  }
}
```

### 2. WiFi Component

#### 2.1 Wifi.GetStatus
**Purpose**: Retrieve WiFi connection status and network configuration

**Request Format**:
```json
{
  "id": 0,
  "method": "Wifi.GetStatus",
  "params": {
    "id": 0
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "wifi_mac": "string",
    "ssid": "string",
    "rssi": number,
    "sta_ip": "string",
    "sta_gate": "string",
    "sta_mask": "string",
    "sta_dns": "string"
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.wifi_mac`: string (WiFi MAC address)
- `result.ssid`: string or null (WiFi network name)
- `result.rssi`: number (WiFi signal strength in dBm)
- `result.sta_ip`: string or null (Device IP address)
- `result.sta_gate`: string or null (Gateway IP address)
- `result.sta_mask`: string or null (Subnet mask)
- `result.sta_dns`: string or null (DNS server address)

**Usage Notes**:
- RSSI values typically range from -100 (weak) to 0 (strong)
- Null values indicate unavailable or not configured
- Used for network diagnostics and connectivity monitoring

**Example Response**:
```json
{
  "id": 1,
  "src": "VenusC-mac",
  "result": {
    "id": 0,
    "ssid": "Hame",
    "rssi": -59,
    "sta_ip": "192.168.137.41",
    "sta_gate": "192.168.137.1",
    "sta_mask": "255.255.255.0",
    "sta_dns": "192.168.137.1"
  }
}
```

### 3. Bluetooth Component

#### 3.1 BLE.GetStatus
**Purpose**: Check Bluetooth connection status

**Request Format**:
```json
{
  "id": 0,
  "method": "BLE.GetStatus",
  "params": {
    "id": 0
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "state": "string",
    "ble_mac": "string"
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.state`: string (Bluetooth state: "connect", "disconnect", etc.)
- `result.ble_mac`: string (Bluetooth MAC address)

**Usage Notes**:
- State values may vary by firmware version
- Used for Bluetooth connectivity monitoring
- May be used for mobile app pairing status

**Example Response**:
```json
{
  "id": 1,
  "src": "VenusC-123456789012",
  "result": {
    "id": 0,
    "state": "connect",
    "ble_mac": "123456789012"
  }
}
```

### 4. Battery Component

#### 4.1 Bat.GetStatus
**Purpose**: Query battery information and operating status

**Request Format**:
```json
{
  "id": 0,
  "method": "Bat.GetStatus",
  "params": {
    "id": 0
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "soc": "string",
    "charg_flag": boolean,
    "dischrg_flag": boolean,
    "bat_temp": number,
    "bat_capacity": number,
    "rated_capacity": number
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.soc`: string (State of Charge percentage)
- `result.charg_flag`: boolean (Charging permission flag)
- `result.dischrg_flag`: boolean (Discharge permission flag)
- `result.bat_temp`: number or null (Battery temperature in °C)
- `result.bat_capacity`: number or null (Battery remaining capacity in Wh)
- `result.rated_capacity`: number or null (Battery rated capacity in Wh)

**Usage Notes**:
- SOC is returned as string, may need conversion to number
- Temperature may require scaling based on firmware version
- Capacity values may need scaling (typically /10 or /100)
- Flags indicate device permissions for charging/discharging

**Example Response**:
```json
{
  "id": 1,
  "src": "VenusC-mac",
  "result": {
    "id": 0,
    "soc": "98",
    "charg_flag": true,
    "dischrg_flag": true,
    "bat_temp": 25.0,
    "bat_capacity": 2508.0,
    "rated_capacity": 2560.0
  }
}
```

### 5. PV Component

#### 5.1 PV.GetStatus
**Purpose**: Query photovoltaic charging information

**Request Format**:
```json
{
  "id": 0,
  "method": "PV.GetStatus",
  "params": {
    "id": 0
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "pv_power": number,
    "pv_voltage": number,
    "pv_current": number
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.pv_power`: number (Photovoltaic charging power in W)
- `result.pv_voltage`: number (Photovoltaic charging voltage in V)
- `result.pv_current`: number (Photovoltaic charging current in A)

**Usage Notes**:
- Only available on Venus D model
- Provides real-time solar generation data
- Used for solar efficiency monitoring
- Power = Voltage × Current (should match pv_power)

**Example Response**:
```json
{
  "id": 1,
  "src": "VenusD-mac",
  "result": {
    "id": 0,
    "pv_power": 580.0,
    "pv_voltage": 40.0,
    "pv_current": 12.0
  }
}
```

### 6. ES Component (Energy System)

#### 6.1 ES.GetStatus
**Purpose**: Query basic electrical energy information and statistics

**Request Format**:
```json
{
  "id": 0,
  "method": "ES.GetStatus",
  "params": {
    "id": 0
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "bat_soc": number,
    "bat_cap": number,
    "pv_power": number,
    "ongrid_power": number,
    "offgrid_power": number,
    "bat_power": number,
    "total_pv_energy": number,
    "total_grid_output_energy": number,
    "total_grid_input_energy": number,
    "total_load_energy": number
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.bat_soc`: number (Total battery SOC in %)
- `result.bat_cap`: number (Total battery capacity in Wh)
- `result.pv_power`: number (Solar charging power in W)
- `result.ongrid_power`: number (Grid-tied power in W)
- `result.offgrid_power`: number (Off-grid power in W)
- `result.bat_power`: number (Battery power in W)
- `result.total_pv_energy`: number (Total solar energy generated in Wh)
- `result.total_grid_output_energy`: number (Total grid output energy in Wh)
- `result.total_grid_input_energy`: number (Total grid input energy in Wh)
- `result.total_load_energy`: number (Total load energy consumed in Wh)

**Usage Notes**:
- Primary data source for energy monitoring
- Energy values may need scaling based on firmware version
- Power values are real-time measurements
- Grid input/output represent import/export from/to grid
- Load energy represents off-grid consumption

**Example Response**:
```json
{
  "id": 1,
  "src": "VenusC-mac",
  "result": {
    "id": 0,
    "bat_soc": 98,
    "bat_cap": 2560,
    "pv_power": 0,
    "ongrid_power": 100,
    "offgrid_power": 0,
    "bat_power": 0,
    "total_pv_energy": 0,
    "total_grid_output_energy": 844,
    "total_grid_input_energy": 1607,
    "total_load_energy": 0
  }
}
```

#### 6.2 ES.SetMode
**Purpose**: Configure device operating mode

**Request Format**:
```json
{
  "id": 0,
  "method": "ES.SetMode",
  "params": {
    "id": 0,
    "config": {
      "mode": "string",
      "auto_cfg": {},
      "ai_cfg": {},
      "manual_cfg": {},
      "passive_cfg": {}
    }
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)
- `config.mode`: string (Operating mode: "Auto", "AI", "Manual", "Passive")
- `config.auto_cfg`: object (Auto mode configuration)
- `config.ai_cfg`: object (AI mode configuration)
- `config.manual_cfg`: object (Manual mode configuration)
- `config.passive_cfg`: object (Passive mode configuration)

**Auto Mode Configuration**:
```json
{
  "enable": 1
}
```

**AI Mode Configuration**:
```json
{
  "enable": 1
}
```

**Manual Mode Configuration**:
```json
{
  "time_num": 0,
  "start_time": "HH:MM",
  "end_time": "HH:MM",
  "week_set": number,
  "power": number,
  "enable": 0 or 1
}
```

**Manual Mode Parameters**:
- `time_num`: number (Time period serial number, 0-9)
- `start_time`: string (Start time in HH:MM format)
- `end_time`: string (End time in HH:MM format)
- `week_set`: number (Week bitmask, 127 = all days)
- `power`: number (Setting power in W, negative for charge)
- `enable`: number (ON: 1, OFF: 0)

**Week Set Bitmask**:
- Bit 0 (LSB): Monday
- Bit 1: Tuesday
- Bit 2: Wednesday
- Bit 3: Thursday
- Bit 4: Friday
- Bit 5: Saturday
- Bit 6: Sunday
- Example: 127 = 0b1111111 (all days)

**Passive Mode Configuration**:
```json
{
  "power": number,
  "cd_time": number
}
```

**Passive Mode Parameters**:
- `power`: number (Setting power in W)
- `cd_time`: number (Power countdown in seconds)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "set_result": boolean
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.set_result`: boolean (True = success, False = failure)

**Usage Notes**:
- Mode changes require device support
- Manual mode allows scheduling with time periods
- Passive mode provides temporary power control
- AI mode may not be available on all firmware versions

**Example Request (Auto Mode)**:
```json
{
  "id": 1,
  "method": "ES.SetMode",
  "params": {
    "id": 0,
    "config": {
      "mode": "Auto",
      "auto_cfg": {
        "enable": 1
      }
    }
  }
}
```

**Example Request (Manual Mode)**:
```json
{
  "id": 1,
  "method": "ES.SetMode",
  "params": {
    "id": 0,
    "config": {
      "mode": "Manual",
      "manual_cfg": {
        "time_num": 1,
        "start_time": "08:30",
        "end_time": "20:30",
        "week_set": 127,
        "power": 100,
        "enable": 1
      }
    }
  }
}
```

**Example Request (Passive Mode)**:
```json
{
  "id": 1,
  "method": "ES.SetMode",
  "params": {
    "id": 0,
    "config": {
      "mode": "Passive",
      "passive_cfg": {
        "power": 100,
        "cd_time": 300
      }
    }
  }
}
```

**Example Response**:
```json
{
  "id": 1,
  "src": "Venus-mac",
  "result": {
    "id": 0,
    "set_result": true
  }
}
```

#### 6.3 ES.GetMode
**Purpose**: Get current operating mode information

**Request Format**:
```json
{
  "id": 0,
  "method": "ES.GetMode",
  "params": {
    "id": 0
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "mode": "string",
    "ongrid_power": number,
    "offgrid_power": number,
    "bat_soc": number
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.mode`: string (Current mode: "Auto", "AI", "Manual", "Passive")
- `result.ongrid_power`: number (Grid-tied power in W)
- `result.offgrid_power`: number (Off-grid power in W)
- `result.bat_soc`: number (Battery SOC in %)

**Usage Notes**:
- Provides current mode status
- Includes real-time power values
- Used for mode monitoring and verification

**Example Response**:
```json
{
  "id": 0,
  "src": "VenusC-mac",
  "result": {
    "id": 0,
    "mode": "Passive",
    "ongrid_power": 100,
    "offgrid_power": 0,
    "bat_soc": 98
  }
}
```

### 7. EM Component (Energy Meter)

#### 7.1 EM.GetStatus
**Purpose**: Query energy meter status and power measurement data

**Request Format**:
```json
{
  "id": 0,
  "method": "EM.GetStatus",
  "params": {
    "id": 0
  }
}
```

**Parameters**:
- `id`: number (Instance ID, typically 0)

**Response Format**:
```json
{
  "id": 0,
  "src": "string",
  "result": {
    "id": 0,
    "ct_state": number,
    "a_power": number,
    "b_power": number,
    "c_power": number,
    "total_power": number
  }
}
```

**Response Fields**:
- `id`: number (Instance ID)
- `result.ct_state`: number (CT status: 0=Not connected, 1=Connected)
- `result.a_power`: number (Phase A power in W)
- `result.b_power`: number (Phase B power in W)
- `result.c_power`: number (Phase C power in W)
- `result.total_power`: number (Total power in W)

**Usage Notes**:
- CT (Current Transformer) status indicates grid connection
- Three-phase power measurements for balanced load monitoring
- Total power should equal sum of A+B+C (within tolerance)
- Used for grid connection monitoring and three-phase analysis

**Example Response**:
```json
{
  "id": 1,
  "src": "VenusC-mac",
  "result": {
    "id": 0,
    "ct_state": 0,
    "a_power": 0,
    "b_power": 0,
    "c_power": 0,
    "total_power": 0
  }
}
```

## Device Support Matrix

| Component | Venus C | Venus E | Venus D |
|-----------|---------|---------|---------|
| Marstek   | ✓       | ✓       | ✓       |
| WiFi      | ✓       | ✓       | ✓       |
| Bluetooth | ✓       | ✓       | ✓       |
| Battery   | ✓       | ✓       | ✓       |
| PV        | ✗       | ✗       | ✓       |
| ES        | ✓       | ✓       | ✓       |
| EM        | ✓       | ✓       | ✓       |

## Firmware Version Considerations

### Data Scaling
Different firmware versions may use different scaling factors for energy values:

**Firmware < 154**:
- Energy values typically divided by 100
- Example: `bat_capacity: 256000` → `2560.0 Wh`

**Firmware >= 154**:
- Energy values typically divided by 1000
- Example: `bat_capacity: 2560000` → `2560.0 Wh`

**Implementation Strategy**:
```javascript
const divisor = (firmware >= 154) ? 1000.0 : 100.0;
const capacity = rawValue / divisor;
```

### Temperature Scaling
Battery temperature may require scaling:
```javascript
if (temperature > 50) {
  temperature /= 10.0; // Apply scaling if value seems too high
}
```

## Communication Protocol Details

### UDP Socket Configuration
- **Local Port**: Dynamic (OS assigned) for receiving
- **Remote Port**: 30000 (configurable 49152-65535)
- **Broadcast Address**: Network broadcast address
- **Message ID**: 16-bit integer, unique per request

### Message Flow
1. **Discovery**: Broadcast `Marstek.GetDevice` to find devices
2. **Identification**: Parse responses to identify device models
3. **Configuration**: Set up device-specific communication
4. **Polling**: Regular requests for status updates
5. **Control**: Send mode/configuration commands as needed

### Error Handling
- **Network Timeout**: 10 seconds recommended
- **Invalid Response**: Retry mechanism with exponential backoff
- **Device Unavailable**: Graceful degradation of functionality
- **Firmware Mismatch**: Feature detection and fallback

## Implementation Guidelines

### 1. Device Discovery
```javascript
// Broadcast discovery message
const discoveryMessage = {
  id: 1,
  method: "Marstek.GetDevice",
  params: { ble_mac: "0" }
};

// Send via UDP broadcast
socket.broadcast(JSON.stringify(discoveryMessage));
```

### 2. Status Polling
```javascript
// Poll essential status
const statusRequests = [
  { method: "ES.GetStatus", params: { id: 0 } },
  { method: "ES.GetMode", params: { id: 0 } },
  { method: "EM.GetStatus", params: { id: 0 } }
];

// Send requests with unique IDs
statusRequests.forEach((req, index) => {
  req.id = index + 100; // Unique ID
  socket.send(JSON.stringify(req), deviceIP);
});
```

### 3. Mode Control
```javascript
// Set manual mode
const manualModeConfig = {
  id: 1,
  method: "ES.SetMode",
  params: {
    id: 0,
    config: {
      mode: "Manual",
      manual_cfg: {
        time_num: 0,
        start_time: "08:30",
        end_time: "20:30",
        week_set: 127,
        power: 100,
        enable: 1
      }
    }
  }
};

socket.send(JSON.stringify(manualModeConfig), deviceIP);
```

### 4. Data Processing
```javascript
function processEnergyData(result, firmwareVersion) {
  const divisor = (firmwareVersion >= 154) ? 1000.0 : 100.0;
  
  return {
    soc: result.bat_soc,
    capacity: result.bat_cap / divisor,
    gridImport: result.total_grid_input_energy / divisor,
    gridExport: result.total_grid_output_energy / divisor,
    solarGeneration: result.total_pv_energy / divisor
  };
}
```

## Security Considerations

### Network Security
- **Local Network Only**: API operates on LAN, no internet exposure
- **No Authentication**: No built-in authentication mechanism
- **Broadcast Discovery**: Open to any device on network
- **Port Configuration**: Use non-standard ports for security through obscurity

### Data Privacy
- **Local Processing**: All data processed locally on Homey
- **No Cloud Transmission**: Data not sent to external services
- **User Control**: Users control data collection and retention

## Performance Optimization

### Polling Strategy
- **Frequency**: 60-second intervals for most data
- **Prioritization**: Essential data polled more frequently
- **Batching**: Multiple requests in single polling cycle
- **Adaptive**: Adjust frequency based on device responsiveness

### Memory Management
- **Circular Buffer**: Limit stored historical data
- **Automatic Cleanup**: Remove old data automatically
- **Efficient Storage**: Use compact data structures
- **Garbage Collection**: Regular cleanup of unused objects

## Troubleshooting Guide

### Common Issues

1. **Device Not Found**
   - Check network connectivity
   - Verify Open API is enabled in Marstek app
   - Confirm device is powered and connected

2. **No Response to Commands**
   - Verify device IP address
   - Check UDP port configuration
   - Ensure device is in responsive state

3. **Incorrect Data Values**
   - Check firmware version for scaling
   - Verify data type conversions
   - Validate unit conversions

4. **Intermittent Connectivity**
   - Check WiFi signal strength
   - Verify network stability
   - Consider static IP configuration

### Diagnostic Commands
```javascript
// Test device connectivity
const testCommand = {
  id: 999,
  method: "ES.GetStatus",
  params: { id: 0 }
};

// Monitor response time and success rate
// Log network statistics and error patterns
```

This comprehensive technical specification provides all necessary details for implementing the Marstek Device Open API in the Homey Marstek Battery Connector application.