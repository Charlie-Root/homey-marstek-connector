# Marstek Venus Connector

This Homey app connects to a Marstek Venus battery system either through the local network or via the Marstek cloud service and retrieves battery statistics. It allows you to monitor the battery status, charge level, and other relevant information directly from your Homey smart home system. Using flows you can send commands to the battery to change mode (local API only). There is an auto-detect algorithm that tries to find your Marstek Venus batteries.

## FEATURES

When a device is detected and communication is working, the device will display various statistics such as:
- Battery charge level
- Status (charging, discharging, idle)
- Power left (in kilowatts/hours)
- Grid/Off-grid power
- Current power output or intake (Watt)
- Battery Temperature
- Charge and discharge totals (kWh)
- Phase A/B/C Power (Watt)
- Total Power (Watt)
- CT State (Connected/Not Connected)
- Current Battery Mode

You can control the battery mode directly from the device page (AI, Auto, Force Charge, Force Discharge) or send commands to change the operating mode to 'Manual', 'AI', 'Passive' or 'Auto' using Homey flows ('Then...'). Force Charge and Force Discharge power levels are configurable in device settings. A simplified manual mode flow card allows setting manual mode with text input for start time and auto-calculated 2-hour duration.

## REQUIREMENTS

This app requires Homey and a Marstek Venus battery system.

- When using the **local API driver** the Homey and battery must be connected to the same network with the local API enabled (see below). Auto-detection of Marstek Venus batteries is supported on the same local network; it will search within the last octet (y) from 1 to 254.
- When using the **cloud driver** you need an active Marstek cloud/app account. During pairing Homey will ask for the username and password to authenticate with the Marstek cloud service.

### DEVICE PAIRING (CLOUD)

Choose the “Marstek Venus (Cloud)” device during pairing, sign in with your Marstek cloud credentials and select the site/device you want to add. Credentials are securely stored in the device store and used solely for refreshing the battery statistics from the Marstek cloud endpoints.

### DEVICE PAIRING (LOCAL API)

The Local API is disabled by default, this needs te be enabled on the Marstek Venus battery system. This can be done in two ways:
- Use the BLE Test Tool (https://rweijnen.github.io/marstek-venus-monitor/latest/) on your smartphone (or laptop) near the battery. Connect and use 'Enable Local API (30000)' button in 'System' tab.
- Contact Marstek support to have them enable the Local API for you. This can take a few days.
- In the settings of the Marstek Venus battery syste using the APP (newer versions), make sure the 'Local API' is enabled and the port number is set to 30000.

## STEP BY STEP INSTRUCTIONS

1. Install the MarstekHomey app from the Homey App Store.
2. Add new device using Marstek Battery Connector
3. Select type of connection to make:
- For API: system will auto detect
- For Cloud: Enter your App/Cloud credentials and let it auto detect
4. Select/check all devices to add and click continue to add them to Homey.
5. Watch the magic happen as the battery statistics are retrieved and displayed in the device card(s).

You can devices from both API and Cloud. See settings of each battery for additional details. 

## VERSION HISTORY

- 0.8.9 - Added direct battery mode control from device page (AI, Auto, Force Charge, Force Discharge). Added current mode display. Added configurable force charge/discharge power settings. Added EM.GetStatus polling for phase powers and CT state. Added simplified manual mode flow card with auto-calculated 2-hour duration.
- 0.8.8 - UDP broadcast or sending individual UDP packages to individual batteries is now configurable (defaults to broadcast).
- 0.8.7 - The 'ES.GetStatus' messages are no longer using UDP broadcast but now directly target the IP address of the device, sending out one request per device.
- 0.8.6 - Debugging added when message details source does not match configured source(s).
- 0.8.5 - Additional debugging logs added for improving Marstek Venus compatibility, only for TEST version of this app.
- 0.8.4 - Polling interval could not always be determined when upgrading the Homey app from previous versions, added a fallback interval value.
- 0.8.3 - Bug removed that caused no data to be processed from the local API. Debug flag is now always set for TEST versions fo the app.
- 0.8.2 - Default settings can be given during pairing of local API devices. Added escaping of strings during cloud login. Unique id for messages limited to 16bits integer.
- 0.8.1 - **[current LIVE release]** Added settings to disable polling for data from local API, but flows sending battery commands are still possible, to alleviate communication issues when used together with CT002/CT003.
- 0.8.0 - Code structure changes and github cleanup. Converted source to TypeScript only.
- 0.7.6 - Cloud data stopped updating when initial response of Marstek Cloud service was slow, causing a concurrency problem.
- 0.7.5 - Incorrect password for Marstek Cloud could not be corrected without removing app first. Technical errors on the Marstek Cloud service are not correctly caught.
- 0.7.4 - Temperature reported by same firmware has different multiplier; sanity calculation added. Marstek Cloud login problems were not handled correctly.
- 0.7.3 - Cloud login could fail for users with multiple devices. Added some translations.
- 0.7.2 - Temperature for firmware 154 was reported incorrectly. Added retry meganism to the flow cards that set battery mode. Improved readability of some library classes.
- 0.7.1 - Added flow card for changing the battery charging mode through local API.
- 0.7.0 - Added support for a Marstek cloud driver that retrieves battery statistics using your Marstek cloud account credentials.
- 0.6.3 - Added a property that monitors the number of seconds the last message was received from battery. Added icons for custom capabilities.
- 0.6.2 - Firmware setting was stored as incorrect settings type.
- 0.6.1 - Firmware 154 seems to communicate values with a different multipliers. The app now detects the firmware and corrects this.
- 0.6.0 - Auto re-connect implemented; retry port binding at every broadcast when listener is no longer available. Fixed errors on multiple devices trying to start connecting at the same time. Couple of other minor bugs in several places fixed.
- 0.5.7 - Correctly implemented setting of Homey capabilities as async calls.
- 0.5.6 - Scope seems no longer available during close event handling, so logging close event is now hard-coded to console.
- 0.5.5 - The socket UDP dgram does not have a destroy function, calling this caused a crash during de-installation of the App.
- 0.5.4 - Log structure changed to try to catch connectivity problems. Solved problem in clean-up function.
- 0.5.3 - Applied bug fix to broadcast IP address discovery (caused problems when no address is found).
- 0.5.2 - Added an increment unique id to all messages to battery. Restructured the way details are retrieved from messages into Homey capability values. Additional onUninit handling for removal of UDP listener. Added more capabilities received from battery (unverified).
- 0.5.1 - Handling of errors on socket binding and broadcast flag settings for better debugging of future port binding errors. Removed some mandatory settings that gave problems during discovery.
- 0.5.0 - Added additional readings from the battery API and energy system that are now visualised in Homey as their guideliness for batteries.
(older history details are left out)

## NOTES

- This app uses the 'API over UDP' features as mentioned in the API documentation. 
- The app is developed and tested with a Venus E v2.0 battery system (firmware v153, communication module 202409090159). Let me know if any other models work as well!
- When the device can't be auto-detected you can manually add the device using the IP address of the battery. If the device is not found, please check if the Marstek Venus battery is powered on and connected to the same network as Homey.
- Support for multiple Marstek Venus batteries is implemented, but since I only have one battery to test with, some is uncharted.
- When upgrading the app, it might be needed to remove already added battery devices first and then adding them again. 
- The Marstek Cloud API is undocumented, so things might change without notice.
- Battery mode changes have an automatic retry for a maximum of 5 tries with a 15 seconds timeout.

## KNOWN ISSUES

- Sometimes UDP communication stops after a while (without any exception, warning).
- Not all transmitted UDP packages are being answered by the battery (it is silently ignoring them).
- Does not seem to work well in conjuction with CT002 or CT003, battery seems to stop communicating. 
- Cloud data does not take back-up power port correctly into account (show 1 Watt)
- Using Cloud device seems to log-out app (single login token only allowed by Marstek)

# TROUBLESHOOTING

The local API of battery has some communication issues. Not all UDP messages are answered and there seem to be some conflicts when using other methods to communicate with the battery at the same time. The communication seems to deteriorate over time until it stops completely. Users with firmware 154 report less problems. Communication can be kick-started by using the BLE Test Tool (https://rweijnen.github.io/marstek-venus-monitor/latest/) v2.0 under the 'Advances' tab using the 'System Reset' function. Note that power delivery will be interrupted for a brief moment, and after that the communication stack will respond again to all messages.