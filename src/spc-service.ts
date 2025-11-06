import { AreaMode, siaToAreaMode, siaToZoneInput, ZoneInput, ZoneStatus, ZoneType } from './spc-base';
import { SpcConfig } from './spc-web-gateway-to-mqtt';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { WebSocket } from 'ws';
import * as https from 'https';
import * as crypto from 'crypto';
import * as URL from 'url';

export type PanelOverview = {
  panel: {
    type: string;
    variant: string;
    sw_version: string;
    hw_version: string;
    serial_nbr: string;
  };
  areas: [
    {
      id: number;
      name: string;
    },
  ];
  zones: [
    {
      id: number;
      name: string;
      status: ZoneStatus;
      area: number;
      type: ZoneType;
    },
  ];
};

export type PanelStates = {
  battery_voltage: number;
  aux_voltage: number;
  aux_current_ma: number;
};

export type ZoneState = {
  id: number;
  input: ZoneInput;
  status: ZoneStatus;
};

export type AreaState = {
  id: number;
  mode: AreaMode;
};

export class SpcService {
  private config: SpcConfig;
  private axiosClient: AxiosInstance;
  private wsClient: WebSocket | undefined;
  private wsConnected = false;
  private ncount = 0;
  private eventCallback: (state: ZoneState | AreaState, anonymousData: any) => Promise<void>;
  private eventCallbackData: any;

  constructor(
    config: SpcConfig,
    eventCallback: (zoneState: ZoneState | AreaState, anonymousData: any) => Promise<void>,
    eventCallbackData: any,
  ) {
    this.config = config;
    this.eventCallback = eventCallback;
    this.eventCallbackData = eventCallbackData;

    this.axiosClient = axios.create({
      baseURL: `${this.config.use_tls ? 'https' : 'http'}://${this.config.hostname}:${this.config.port}/spc/`,
      ...(this.config.use_tls ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {}),
    });

    this.connectWs();
  }

  async getPanelOverview(): Promise<PanelOverview> {
    const overview = {} as PanelOverview;

    const panelData = await this.spcGet('panel');

    if (panelData) {
      overview.panel = {
        type: panelData.panel?.type,
        variant: panelData.panel?.variant,
        sw_version: panelData.panel?.version,
        serial_nbr: panelData.panel?.sn,
        hw_version: `${panelData.panel?.hw_ver_major}.${panelData.panel?.hw_ver_minor}`,
      };
    }

    const areaData = await this.spcGet('area');

    if (areaData && areaData.area) {
      const areas = areaData.area.map((area: Record<string, any>) => {
        return {
          id: area.id,
          name: area.name,
        };
      });

      overview.areas = areas;
    }

    const zoneData = await this.spcGet('zone');

    if (zoneData && zoneData.zone) {
      const zones = zoneData.zone.map((zone: Record<string, any>) => {
        return {
          id: zone.id,
          name: zone.zone_name,
          status: zone.status as ZoneStatus,
          area: zone.area,
          type: zone.type as ZoneType,
        };
      });

      overview.zones = zones;
    }

    return overview;
  }

  async getPanelStates(): Promise<PanelStates | undefined> {
    const panelData = await this.spcGet('psu');

    if (panelData) {
      return {
        battery_voltage: Number.parseFloat(String(panelData.psu?.batt_volt).replace('V', '')),
        aux_voltage: Number.parseFloat(String(panelData.psu?.aux_volt).replace('V', '')),
        aux_current_ma: Number.parseFloat(String(panelData.psu?.aux_curr).replace('mA', '')),
      };
    }
  }

  async getZoneStates(): Promise<ZoneState[]> {
    const zoneData = await this.spcGet('zone');

    if (zoneData && zoneData.zone) {
      return zoneData.zone.map((zone: Record<string, any>) => {
        return {
          id: zone.id,
          input: zone.input as ZoneInput,
          status: zone.status as ZoneStatus,
        };
      });
    }

    return [];
  }

  async getAreaStates(): Promise<AreaState[]> {
    const areaData = await this.spcGet('area');

    if (areaData && areaData.area) {
      return areaData.area.map((area: Record<string, any>) => {
        return {
          id: area.id,
          mode: area.mode as AreaMode,
        };
      });
    }

    return [];
  }

  private async spcGet(path: string): Promise<Record<string, any> | null> {
    let spcData = null;
    let retryOnce = false;
    let options = {};

    do {
      try {
        const { data } = await this.axiosClient.get(path, options);

        if (data.status === 'success') {
          spcData = data.data;
        }
        retryOnce = false;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const ae = error as AxiosError;

          if (ae.response?.status === 401 && ae.response?.headers['www-authenticate'] && this.config.get_username) {
            retryOnce = !retryOnce;

            const auth = this.digest(
              'GET',
              URL.parse(this.axiosClient.defaults.baseURL + path)?.pathname || '/',
              ae.response?.headers['www-authenticate'],
              this.config.get_username,
              this.config.get_password || '',
            );
            options = { headers: { Authorization: auth } };
          } else {
            console.error(`Error reading SPC panel info: ${(error as AxiosError).message}`);
            retryOnce = false;
          }
        } else {
          console.error(`Error reading SPC panel info: ${error}`);
          retryOnce = false;
        }
      }
    } while (retryOnce);

    return spcData;
  }

  private async connectWs(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.terminate();
    }
    this.wsClient = new WebSocket(
      `${this.config.use_tls ? 'wss' : 'ws'}://${this.config.hostname}:${this.config.port}/ws/spc?username=${this.config.ws_username}&password=${this.config.ws_password}`,
      { rejectUnauthorized: false },
    );

    this.wsClient.on('open', () => {
      this.wsConnected = true;
    });

    this.wsClient.on('close', (code, reason) => {
      console.error('WS connection closed: ', reason);
      this.wsConnected = false;
    });

    this.wsClient.on('error', (event: ErrorEvent) => {
      console.error('WS error: ', event.message);
    });

    this.wsClient.on('message', async (buf: Buffer) => {
      if (buf) {
        const msg = JSON.parse(buf.toString('utf-8'));
        if (msg.status === 'success' && msg.data && msg.data.sia) {
          const sia = msg.data.sia;
          if (sia.sia_code && sia.sia_address && sia.description) {
            if (['ZO', 'ZC', 'ZX', 'ZD', 'ZM'].includes(sia.sia_code)) {
              // const [zoneName, type, areaId, areaName] = sia.description.split('¦');
              const input = siaToZoneInput(sia.sia_code);

              await this.eventCallback({ id: sia.sia_address, input, status: ZoneStatus.OK }, this.eventCallbackData);
            } else if (['CG', 'OG', 'NL'].includes(sia.sia_code)) {
              const areaStates = await this.getAreaStates();
              const matchingArea =
                sia.sia_code === 'NL' ? areaStates.find((area) => area.id === sia.sia_address) : undefined;

              const mode = siaToAreaMode(sia.sia_code, matchingArea?.mode);
              await this.eventCallback({ id: sia.sia_address, mode: mode }, this.eventCallbackData);
            }
          }
        }
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close(1000, 'Normal Closure');
    }
  }

  // Code below is heavily inspired by node module digest-header which is distributed under the following license:
  /*
This software is licensed under the MIT License.

Copyright (C) 2014 fengmk2 <fengmk2@gmail.com> and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE. */

  private digest(method: string, uri: string, wwwAuthHeader: string, username: string, password: string): string {
    const options = new Map<string, string>(
      wwwAuthHeader
        .split(',')
        .map((option) => {
          const kv = /(\w+)=["']?([^'"]{1,10000})["']?/.exec(option);
          if (kv && kv.length >= 3) {
            return [kv[1], kv[2]] as [string, string];
          }

          return undefined;
        })
        .filter((kv): kv is [string, string] => kv !== undefined),
    );

    if (!options.get('realm') || !options.get('nonce')) {
      return '';
    }

    let qop = options.get('qop') || '';

    const nc = String(++this.ncount).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');

    const hash1 = crypto
      .createHash('md5')
      .update(username + ':' + options.get('realm') + ':' + password)
      .digest('hex');
    const hash2 = crypto
      .createHash('md5')
      .update(method.toUpperCase() + ':' + uri)
      .digest('hex');

    let s = hash1 + ':' + options.get('nonce');
    if (qop) {
      qop = qop.split(',')[0];
      s += ':' + nc + ':' + cnonce + ':' + qop;
    }
    s += ':' + hash2;
    const response = crypto.createHash('md5').update(s).digest('hex');
    let authString = `Digest username="${username}", realm="${options.get('realm')}", nonce="${options.get('nonce')}", uri=${uri}, response="${response}"`;
    if (options.get('opaque')) {
      authString += `, opaque="${options.get('opaque')}"`;
    }
    if (qop) {
      authString += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    }

    return authString;
  }
}
