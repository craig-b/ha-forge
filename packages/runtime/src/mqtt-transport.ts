import mqtt from 'mqtt';
import type {
  EntityType,
  ResolvedEntity,
  SensorDefinition,
  BinarySensorDefinition,
  SwitchDefinition,
} from '@ha-ts-entities/sdk';
import type { Transport } from './transport.js';

const AVAILABILITY_TOPIC = 'ts-entities/availability';
const HA_STATUS_TOPIC = 'homeassistant/status';
const ADDON_VERSION = '0.1.0';

export interface MqttCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  protocol?: string;
}

export interface MqttTransportOptions {
  credentials: MqttCredentials;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export class MqttTransport implements Transport {
  private client: mqtt.MqttClient | null = null;
  private registeredEntities = new Map<string, ResolvedEntity>();
  private commandHandlers = new Map<string, (command: unknown) => void>();
  private deviceConfigs = new Map<string, Record<string, unknown>>();
  private options: MqttTransportOptions;

  constructor(options: MqttTransportOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const { credentials } = this.options;

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect({
        host: credentials.host,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        protocolVersion: credentials.protocol === '5' ? 5 : 4,
        will: {
          topic: AVAILABILITY_TOPIC,
          payload: Buffer.from('offline'),
          qos: 1,
          retain: true,
        },
        reconnectPeriod: 1000,
        connectTimeout: 10000,
      });

      this.client.on('connect', () => {
        this.publishAvailability('online');
        this.subscribeHAStatus();
        this.options.onConnect?.();
        resolve();
      });

      this.client.on('error', (err) => {
        this.options.onError?.(err);
        reject(err);
      });

      this.client.on('reconnect', () => {
        // Will re-publish availability and discovery on reconnect
      });

      this.client.on('close', () => {
        this.options.onDisconnect?.();
      });

      this.client.on('message', (topic, payload) => {
        this.handleMessage(topic, payload.toString());
      });
    });
  }

  supports(type: EntityType): boolean {
    const mqttTypes: EntityType[] = [
      'sensor', 'binary_sensor', 'switch', 'light', 'cover', 'climate',
      'fan', 'lock', 'humidifier', 'valve', 'water_heater', 'vacuum',
      'lawn_mower', 'siren', 'number', 'select', 'text', 'button',
      'scene', 'event', 'device_tracker', 'camera', 'alarm_control_panel',
      'notify', 'update', 'image',
    ];
    return mqttTypes.includes(type);
  }

  async register(entity: ResolvedEntity): Promise<void> {
    this.registeredEntities.set(entity.definition.id, entity);

    // Subscribe to command topic for bidirectional entities
    if ('onCommand' in entity.definition) {
      const cmdTopic = `ts-entities/${entity.definition.id}/set`;
      this.client?.subscribe(cmdTopic);
    }

    // Build and publish device discovery
    await this.publishDeviceDiscovery(entity);
  }

  async publishState(
    entityId: string,
    state: unknown,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    const topic = `ts-entities/${entityId}/state`;

    let payload: string;
    if (attributes && Object.keys(attributes).length > 0) {
      payload = JSON.stringify({ state: String(state), ...attributes });
    } else {
      payload = String(state);
    }

    await this.publish(topic, payload, { retain: false });
  }

  onCommand(entityId: string, handler: (command: unknown) => void): void {
    this.commandHandlers.set(entityId, handler);
  }

  async deregister(entityId: string): Promise<void> {
    const entity = this.registeredEntities.get(entityId);
    if (!entity) return;

    // Unsubscribe from command topic
    if ('onCommand' in entity.definition) {
      const cmdTopic = `ts-entities/${entity.definition.id}/set`;
      this.client?.unsubscribe(cmdTopic);
    }

    this.commandHandlers.delete(entityId);
    this.registeredEntities.delete(entityId);

    // Re-publish device config without this entity, or clear if last entity
    await this.removeFromDeviceDiscovery(entity);
  }

  async republishAll(): Promise<void> {
    // Re-publish availability
    await this.publishAvailability('online');

    // Re-publish all device discovery configs
    for (const [deviceId, config] of this.deviceConfigs) {
      const topic = `homeassistant/device/${deviceId}/config`;
      await this.publish(topic, JSON.stringify(config), { retain: true });
    }

    // Re-publish all entity states
    // (The lifecycle manager should handle re-publishing current states)
  }

  async disconnect(): Promise<void> {
    await this.publishAvailability('offline');
    return new Promise((resolve) => {
      if (this.client) {
        this.client.end(false, {}, () => resolve());
      } else {
        resolve();
      }
    });
  }

  // --- Internal methods ---

  private async publishDeviceDiscovery(entity: ResolvedEntity): Promise<void> {
    const { definition, deviceId } = entity;

    // Build or update device config
    let config = this.deviceConfigs.get(deviceId);
    if (!config) {
      config = {
        dev: this.buildDeviceInfo(entity),
        o: {
          name: 'ts-entities',
          sw: ADDON_VERSION,
          url: 'https://github.com/craig-b/ha-ts-entities',
        },
        cmps: {},
        avty_t: AVAILABILITY_TOPIC,
      };
      this.deviceConfigs.set(deviceId, config);
    }

    // Add this entity as a component
    const cmps = config.cmps as Record<string, Record<string, unknown>>;
    cmps[definition.id] = this.buildComponentConfig(entity);

    // Publish
    const topic = `homeassistant/device/${deviceId}/config`;
    await this.publish(topic, JSON.stringify(config), { retain: true });
  }

  private async removeFromDeviceDiscovery(entity: ResolvedEntity): Promise<void> {
    const { definition, deviceId } = entity;
    const config = this.deviceConfigs.get(deviceId);
    if (!config) return;

    const cmps = config.cmps as Record<string, unknown>;
    delete cmps[definition.id];

    const topic = `homeassistant/device/${deviceId}/config`;

    if (Object.keys(cmps).length === 0) {
      // No more entities in this device — remove it
      this.deviceConfigs.delete(deviceId);
      await this.publish(topic, '', { retain: true });
    } else {
      // Re-publish without the removed entity
      await this.publish(topic, JSON.stringify(config), { retain: true });
    }
  }

  private buildDeviceInfo(entity: ResolvedEntity): Record<string, unknown> {
    const dev = entity.definition.device;
    if (dev) {
      return {
        ids: [`ts_entities_${dev.id}`],
        name: dev.name,
        ...(dev.manufacturer && { mf: dev.manufacturer }),
        ...(dev.model && { mdl: dev.model }),
        ...(dev.sw_version && { sw: dev.sw_version }),
        ...(dev.suggested_area && { sa: dev.suggested_area }),
      };
    }

    // Synthetic device from file grouping
    return {
      ids: [`ts_entities_${entity.deviceId}`],
      name: entity.deviceId,
      mf: 'ts-entities',
      mdl: 'User Script',
      sw: ADDON_VERSION,
    };
  }

  private buildComponentConfig(entity: ResolvedEntity): Record<string, unknown> {
    const { definition } = entity;
    const stateTopic = `ts-entities/${definition.id}/state`;

    const base: Record<string, unknown> = {
      p: definition.type,
      uniq_id: `ts_entities_${definition.id}`,
      name: definition.name,
      stat_t: stateTopic,
    };

    // Add icon if specified
    if (definition.icon) {
      base.ic = definition.icon;
    }

    // Add entity category if specified
    if (definition.category) {
      base.ent_cat = definition.category;
    }

    // Add command topic for bidirectional entities
    if ('onCommand' in definition) {
      base.cmd_t = `ts-entities/${definition.id}/set`;
    }

    // Add type-specific config
    switch (definition.type) {
      case 'sensor':
        this.applySensorConfig(base, definition as SensorDefinition);
        break;
      case 'binary_sensor':
        this.applyBinarySensorConfig(base, definition as BinarySensorDefinition);
        break;
      case 'switch':
        this.applySwitchConfig(base, definition as SwitchDefinition);
        break;
    }

    return base;
  }

  private applySensorConfig(base: Record<string, unknown>, def: SensorDefinition): void {
    const config = def.config;
    if (!config) return;
    if (config.device_class) base.dev_cla = config.device_class;
    if (config.unit_of_measurement) base.unit_of_meas = config.unit_of_measurement;
    if (config.state_class) base.stat_cla = config.state_class;
    if (config.suggested_display_precision != null) base.sug_dsp_prc = config.suggested_display_precision;
  }

  private applyBinarySensorConfig(base: Record<string, unknown>, def: BinarySensorDefinition): void {
    const config = def.config;
    if (!config) return;
    if (config.device_class) base.dev_cla = config.device_class;
  }

  private applySwitchConfig(base: Record<string, unknown>, def: SwitchDefinition): void {
    const config = def.config;
    if (!config) return;
    if (config.device_class) base.dev_cla = config.device_class;
  }

  private handleMessage(topic: string, payload: string): void {
    // Handle HA restart
    if (topic === HA_STATUS_TOPIC && payload === 'online') {
      this.republishAll();
      return;
    }

    // Handle command messages: ts-entities/<entity_id>/set
    const match = topic.match(/^ts-entities\/(.+)\/set$/);
    if (match) {
      const entityId = match[1];
      const handler = this.commandHandlers.get(entityId);
      if (handler) {
        try {
          const parsed = JSON.parse(payload);
          handler(parsed);
        } catch {
          // Not JSON — pass as string
          handler(payload);
        }
      }
    }
  }

  private subscribeHAStatus(): void {
    this.client?.subscribe(HA_STATUS_TOPIC);
  }

  private async publishAvailability(status: 'online' | 'offline'): Promise<void> {
    await this.publish(AVAILABILITY_TOPIC, status, { retain: true });
  }

  private publish(topic: string, payload: string, opts: { retain: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client?.connected) {
        reject(new Error('MQTT client not connected'));
        return;
      }
      this.client.publish(topic, payload, { qos: 1, retain: opts.retain }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
