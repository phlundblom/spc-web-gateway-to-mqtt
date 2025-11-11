import { z } from 'zod';
import { loadConfig } from 'zod-config';
import { yamlAdapter } from 'zod-config/yaml-adapter';
import * as path from 'path';
import { MqttService } from './mqtt-service.js';
import { AreaState, PanelOverview, SpcService, ZoneState } from './spc-service.js';
import { AreaMode, areaModeToHA, ZoneInput, ZoneStatus, ZoneType } from './spc-base.js';
import { MD5 } from 'object-hash';

const mqttConfigSchema = z.object({
  hostname: z.string(),
  port: z.number().optional().default(1883),
  use_tls: z.boolean().optional().default(false),
  username: z.string().optional(),
  password: z.string().optional(),
});

const spcConfigSchema = z.object({
  hostname: z.string(),
  port: z.number().optional().default(8088),
  use_tls: z.boolean().optional().default(false),
  ws_username: z.string().optional(),
  ws_password: z.string().optional(),
  get_username: z.string().optional(),
  get_password: z.string().optional(),
});

const configSchema = z.object({
  mqtt: mqttConfigSchema,
  spc: spcConfigSchema,
});

export type Config = z.infer<typeof configSchema>;
export type MqttConfig = z.infer<typeof mqttConfigSchema>;
export type SpcConfig = z.infer<typeof spcConfigSchema>;

interface StateData {
  config: Config;
  mqttService: MqttService;
  spcService: SpcService;
  loopHandle: NodeJS.Timeout | null;
  discoveryHash?: string;
  spcPanelSerial?: string;
}

const LOOP_INTERVAL_MS = 60 * 1000;

async function mainLoop(state: StateData): Promise<void> {
  const panelOverview = await state.spcService.getPanelOverview();

  const discoveryPayload = panelOverviewToHADiscovery(panelOverview);
  const discoveryHash = MD5(discoveryPayload);

  // TODO hash is bad because overview contains statuses
  if (!state.discoveryHash || state.discoveryHash !== discoveryHash) {
    state.mqttService.publish(
      `homeassistant/device/${panelOverview.panel.serial_nbr}/config`,
      JSON.stringify(discoveryPayload),
      true,
    );
    state.spcPanelSerial = panelOverview.panel.serial_nbr;
    state.discoveryHash = discoveryHash;

    // Send online availability
    await state.mqttService.publish(
      `homeassistant/device/${panelOverview.panel.serial_nbr.toLowerCase()}_spc/status`,
      JSON.stringify({ panel: 'online' }),
      false,
    );
  }

  await sendPanelStates(state);
  await sendZoneStatesAndStatuses(state);
  await sendAreaStates(state);

  state.loopHandle = setTimeout(mainLoop, LOOP_INTERVAL_MS, state);
}

export async function main(): Promise<void> {
  const config = await loadConfig({
    schema: configSchema,
    adapters: yamlAdapter({ path: path.join(__dirname + '/..', 'config.yml') }),
  });

  if (!config) {
    console.error('Error handling configuration file');
    process.exit(1);
  }

  const stateData: StateData = {} as StateData;

  const mqttService = new MqttService(config.mqtt);
  const spcService = new SpcService(config.spc, spcEventCallback, stateData);
  const panelOverview = await spcService.getPanelOverview();

  if (!panelOverview || !panelOverview.panel) {
    console.error('Cannot communicate with SPC panel');
    process.exit(1);
  }

  mqttService.setWill({
    topic: `homeassistant/device/${panelOverview.panel.serial_nbr.toLowerCase()}_spc/status`,
    payload: Buffer.from(JSON.stringify({ panel: 'offline' })),
    retain: true,
  });

  stateData.config = config;
  stateData.mqttService = mqttService;
  stateData.spcService = spcService;
  stateData.loopHandle = null;

  process.on('exit', exitHandler.bind(null, stateData));
  process.on('SIGINT', exitHandler.bind(null, stateData));

  stateData.loopHandle = setTimeout(mainLoop, 100, stateData);
  // TODO subscribe to 'homeassistant/status' and trigger a full config + state on 'online'
}

async function spcEventCallback(currentState: ZoneState | AreaState, anonymousData: any) {
  const state = anonymousData as StateData;

  if ('input' in currentState) {
    if ([ZoneInput.OPEN, ZoneInput.CLOSED].includes(currentState.input)) {
      await publishZoneState(state, currentState.id, currentState.input == ZoneInput.CLOSED ? 'OFF' : 'ON');
      await publishZoneStatus(state, currentState.id, 'online');
    } else {
      await publishZoneStatus(state, currentState.id, 'offline');
    }
  } else if ('mode' in currentState) {
    await publishAreaState(state, currentState.id, areaModeToHA(currentState.mode));
  }
}

async function exitHandler(options: StateData) {
  if (options.loopHandle) {
    clearTimeout(options.loopHandle);
  }

  if (options.mqttService) {
    await options.mqttService.disconnect();
  }

  if (options.spcService) {
    await options.spcService.disconnect();
  }

  process.exit();
}

function panelOverviewToHADiscovery(overview: PanelOverview): Record<string, any> {
  const unique = overview.panel.serial_nbr.toLowerCase();

  const zones = new Map<string, any>(
    overview.zones
      ? overview.zones.map((zone) => {
          let deviceClass = {};

          if (
            zone.type == ZoneType.ENTRY_EXIT ||
            zone.name.toLowerCase().includes('door') ||
            zone.name.toLowerCase().includes('dörr')
          ) {
            deviceClass = { device_class: 'door' };
          } else if (zone.type == ZoneType.ALARM) {
            deviceClass = { device_class: 'motion' };
          } else if (zone.type == ZoneType.TAMPER) {
            deviceClass = { device_class: 'tamper' };
          }

          const value = {
            platform: 'binary_sensor',
            name: zone.name,
            value_template: '{{ value_json.state }}',
            unique_id: `${unique}_zone_${zone.id}`,
            state_topic: `homeassistant/binary_sensor/${unique}_zone_${zone.id}/state`,
            availability: [
              {
                topic: `homeassistant/device/${unique}_spc/status`,
                value_template: '{{ value_json.panel }}',
              },
              {
                topic: `homeassistant/binary_sensor/${unique}_zone_${zone.id}/status`,
                value_template: '{{ value_json.status }}',
              },
            ],
            ...deviceClass,
          };

          return [zone.name, value];
        })
      : [],
  );

  const areas = new Map<String, any>(
    overview.areas
      ? overview.areas.map((area) => {
          const value = {
            platform: 'alarm_control_panel',
            name: area.name,
            unique_id: `${unique}_area_${area.id}`,
            state_topic: `homeassistant/alarm_control_panel/${unique}_area_${area.id}/state`,
            value_template: '{{ value_json.state }}',
            command_topic: 'homeassistant/readonly-ignored',
            supported_features: ['arm_home', 'arm_away', 'arm_night', 'trigger'],
          };

          return [area.name, value];
        })
      : [],
  );

  return {
    device: {
      identifiers: [overview.panel.serial_nbr],
      name: 'SPC',
      manufacturer: 'Siemens',
      model: overview.panel.type,
      model_id: overview.panel.variant,
      hw_version: overview.panel.hw_version,
      sw_version: overview.panel.sw_version,
      serial_number: overview.panel.serial_nbr,
    },
    origin: {
      name: 'spc-web-gateway-to-mqtt',
      sw_version: '0.0.1',
      support_url: 'https://github.com/phlundblom/spc-web-gateway-to-mqtt/',
    },
    components: {
      battery_voltage: {
        platform: 'sensor',
        device_class: 'voltage',
        name: 'Battery voltage',
        unit_of_measurement: 'V',
        suggested_display_precision: 1,
        value_template: '{{ value_json.battery_voltage }}',
        unique_id: `${unique}_battery_voltage`,
      },
      aux_voltage: {
        platform: 'sensor',
        device_class: 'voltage',
        name: 'System voltage',
        unit_of_measurement: 'V',
        suggested_display_precision: 1,
        value_template: '{{ value_json.aux_voltage }}',
        unique_id: `${unique}_aux_voltage`,
      },
      aux_current: {
        platform: 'sensor',
        device_class: 'current',
        name: 'System current',
        unit_of_measurement: 'mA',
        suggested_display_precision: 0,
        value_template: '{{ value_json.aux_current }}',
        unique_id: `${unique}_aux_current`,
      },
      // TODO add SPC tamper
      ...Object.fromEntries(zones),
      ...Object.fromEntries(areas),
    },
    state_topic: `homeassistant/sensor/${unique}_spc/state`,
    availability: [
      {
        topic: `homeassistant/device/${unique}_spc/status`,
        value_template: '{{ value_json.panel }}',
      },
    ],
    availability_mode: 'all',
  };
}

async function sendPanelStates(state: StateData): Promise<boolean> {
  const panelStates = await state.spcService.getPanelStates();

  if (!panelStates || !state.spcPanelSerial) {
    return false;
  }

  return await state.mqttService.publish(
    `homeassistant/sensor/${state.spcPanelSerial.toLowerCase()}_spc/state`,
    JSON.stringify({
      battery_voltage: panelStates.battery_voltage,
      aux_voltage: panelStates.aux_voltage,
      aux_current: panelStates.aux_current_ma,
    }),
    false,
  );
}

async function sendZoneStatesAndStatuses(state: StateData): Promise<void> {
  const zoneStates = await state.spcService.getZoneStates();

  if (zoneStates.length == 0 || !state.spcPanelSerial) {
    return;
  }

  const publishRequests = zoneStates.map((zone) => {
    return [
      publishZoneState(state, zone.id, zone.input == ZoneInput.CLOSED ? 'OFF' : 'ON'),
      publishZoneStatus(state, zone.id, zone.status == ZoneStatus.OK ? 'online' : 'offline'),
    ];
  });

  await Promise.all(publishRequests.flat());
}

async function publishZoneState(state: StateData, zoneId: number, zoneState: 'ON' | 'OFF'): Promise<boolean> {
  if (!state.spcPanelSerial) {
    return Promise.reject('No panel serial number available');
  }

  return state.mqttService.publish(
    `homeassistant/binary_sensor/${state.spcPanelSerial?.toLowerCase()}_zone_${zoneId}/state`,
    JSON.stringify({ state: zoneState }),
    false,
  );
}

async function publishZoneStatus(state: StateData, zoneId: number, zoneStatus: 'online' | 'offline'): Promise<boolean> {
  if (!state.spcPanelSerial) {
    return Promise.reject('No panel serial number available');
  }

  return state.mqttService.publish(
    `homeassistant/binary_sensor/${state.spcPanelSerial?.toLowerCase()}_zone_${zoneId}/status`,
    JSON.stringify({ status: zoneStatus }),
    false,
  );
}

async function sendAreaStates(state: StateData): Promise<void> {
  const areaStates = await state.spcService.getAreaStates();

  if (areaStates.length == 0 || !state.spcPanelSerial) {
    return;
  }

  const publishRequests = areaStates.map((area) => {
    return publishAreaState(state, area.id, areaModeToHA(area.mode));
  });

  await Promise.all(publishRequests);
}

async function publishAreaState(
  state: StateData,
  areaId: number,
  areaState: 'armed_away' | 'armed_home' | 'armed_night' | 'disarmed' | 'triggered',
): Promise<boolean> {
  if (!state.spcPanelSerial) {
    return Promise.reject('No panel serial number available');
  }

  return state.mqttService.publish(
    `homeassistant/alarm_control_panel/${state.spcPanelSerial?.toLowerCase()}_area_${areaId}/state`,
    JSON.stringify({ state: areaState }),
    false,
  );
}

// async function publishAreaStatus(state: StateData, areaId: number, areaStatus: 'online' | 'offline'): Promise<boolean> {
//   if (!state.spcPanelSerial) {
//     return Promise.reject('No panel serial number available');
//   }
//
//   return state.mqttService.publish(
//     `homeassistant/alarm_control_panel/${state.spcPanelSerial?.toLowerCase()}_area_${areaId}/status`,
//     JSON.stringify({ status: areaStatus }),
//     false,
//   );
// }
