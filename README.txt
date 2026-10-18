Control your JUWEL aquarium equipment from Homey through the MyJUWEL cloud, the same service the official JUWEL AppControl app uses.

Supported devices

- JUWEL HeliaLux (lighting): supported and tested.
- JUWEL SmartFeed (feeder): supported, but untested.
- JUWEL EccoFlow (pump): basic support, untested.

Own a SmartFeed or EccoFlow? Report what works at github.com/moogblob/homey-juwel-appcontrol/issues

What you can do with a HeliaLux

- Turn the lamp on and off
- Set the overall brightness
- Pick a colour with Homey's colour wheel
- Set the white channel separately
- Switch between Schedule (the lamp follows the daily profile stored in MyJUWEL) and Manual (the lamp shows the values set from Homey)
- Use all of this in Flows, like any other Homey light

What you can do with a SmartFeed

- Feed now, with the feeder's own quantity or a chosen amount (also from Flows)
- Set the feed quantity, and the quantity for the button on the feeder
- Turn the feeder and its status LED on or off
- Get an alarm when the feed chamber is empty or the feeder reports an error
- See when the fish were last fed, and start a Flow when they are fed
- Feeding plans cannot be edited from Homey yet. Use the JUWEL app.

What you can do with an EccoFlow

- Turn the pump on and off, and switch the feeding pause and power limit, where the pump allows it
- See the operating mode and the flow rate
- Change the operating mode and reset the maintenance timers from Flows
- Water temperature and pump alarms are not available, because JUWEL does not describe them for apps

What to expect

- On a HeliaLux, changing the colour, brightness or white level puts the lamp in Manual mode. Manual mode lasts for 1 hour, after which the lamp returns to its schedule by itself, just like a preview in the JUWEL app.
- Homey gets each device's state from the cloud every 30 seconds by default. You can set this to between 10 and 3600 seconds in the device settings. A change made in the JUWEL app or on the device itself can take that long to appear in Homey.
- While a HeliaLux is in Schedule mode, Homey shows the values Manual mode would use, not the light the schedule is currently producing.
- Everything goes through the MyJUWEL cloud, so your devices and Homey need internet access. If the cloud is down, Homey cannot control your devices.
- If a device is offline in MyJUWEL, it shows as unavailable in Homey.

Getting started

1. Make sure your devices are set up and working in the official JUWEL AppControl app.
2. Install this app and open its settings.
3. Enter the email and password of your MyJUWEL account and press Save.
4. Add a device, choose HeliaLux, SmartFeed or EccoFlow, and select your devices.

If MyJUWEL rejects your email or password, your devices show as unavailable until you correct them in the app settings.

Disclaimer

This is an unofficial community app. It is not made, endorsed or supported by JUWEL Aquarium. It uses the MyJUWEL cloud API, which is not publicly documented and may change without notice. The API details come from the Home Assistant integration by Melle79 (github.com/Melle79/juwel-appcontrol).
