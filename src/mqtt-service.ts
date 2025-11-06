import { MqttConfig } from './spc-web-gateway-to-mqtt';
import { connectAsync, MqttClient, IClientOptions } from 'mqtt';

export class MqttService {
  private config: MqttConfig;
  private client: MqttClient | undefined;
  private connected = false;
  private willOptions: IClientOptions['will'] | undefined;

  constructor(config: MqttConfig) {
    this.config = config;
  }

  setWill(will?: IClientOptions['will']) {
    this.willOptions = will;
  }

  async connect(): Promise<void> {
    try {
      this.client = await connectAsync({
        hostname: this.config.hostname,
        port: this.config.port,
        protocol: this.config.use_tls ? 'mqtts' : 'mqtt',
        username: this.config.username,
        password: this.config.password,
        will: this.willOptions,
      });

      this.connected = true;

      this.client.on('connect', () => (this.connected = true));
      this.client.on('offline', () => (this.connected = false));
      console.log('Connected to MQTT server');
    } catch (err) {
      console.error(`Error connecting to MQTT server: ${err}`);
      this.client = undefined;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client = this.client.end();
      this.connected = false;
    }
  }

  async publish(topic: string, msg: string, retain: boolean = false): Promise<boolean> {
    if (!this.client) {
      await this.connect();
      if (!this.client) {
        return false;
      }
    }

    if (!this.connected) {
      console.info('Not connected to MQTT for publish, reconnecting');
      this.client.reconnect();
      if (!this.connected) {
        return false;
      }
    }

    try {
      await this.client.publishAsync(topic, msg, { retain });
    } catch (err) {
      return false;
    }

    return true;
  }
}
