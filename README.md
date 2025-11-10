# Introduction

Even though Lundix AB has replaced the old SPC Web Gateway (SWG) software with a new hardware product, the old gateway is still useful. This small piece of software acts as a bridge between the SWG and the Home Assistant (HA) MQTT integration. The goal is to integrate SPC alarm status into Home Assistant as read-only entities. It should be straight forward to add support for updating entities, but I didn't want or need that functionality. Because of the great discovery support in the HA MQTT integration, zones and areas are automagically created in HA with availability support.

# Configuration

The `index.js` is kept simple and does not support any command line arguments. Just edit the `config.yml` file and make sure it is available for the compiled JS.

# TODOs

The SPC panel and X-Bus unit statuses for tamper and similar should be added as entities.
