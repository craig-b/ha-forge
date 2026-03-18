import mqtt from 'mqtt';
import type {
  EntityType,
  ResolvedEntity,
  SensorDefinition,
  BinarySensorDefinition,
  SwitchDefinition,
  LightDefinition,
  CoverDefinition,
  ClimateDefinition,
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
  onReconnect?: () => void;
  /** Max consecutive failures before marking an entity unavailable (default: 3) */
  maxFailuresBeforeUnavailable?: number;
}

export class MqttTransport implements Transport {
  private client: mqtt.MqttClient | null = null;
  private registeredEntities = new Map<string, ResolvedEntity>();
  private commandHandlers = new Map<string, (command: unknown) => void>();
  private deviceConfigs = new Map<string, Record<string, unknown>>();
  private entityFailures = new Map<string, number>();
  private entityAvailability = new Map<string, boolean>();
  private options: MqttTransportOptions;
  private maxFailures: number;

  constructor(options: MqttTransportOptions) {
    this.options = options;
    this.maxFailures = options.maxFailuresBeforeUnavailable ?? 3;
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
        this.options.onReconnect?.();
      });

      // On successful reconnection, re-publish everything
      let firstConnect = true;
      this.client.on('connect', () => {
        if (!firstConnect) {
          this.republishAll().catch(() => {});
        }
        firstConnect = false;
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

    const id = entity.definition.id;

    // Subscribe to command topics for bidirectional entities
    if ('onCommand' in entity.definition) {
      this.client?.subscribe(`ts-entities/${id}/set`);

      // Cover needs additional position/tilt command topics
      if (entity.definition.type === 'cover') {
        const coverConfig = (entity.definition as CoverDefinition).config;
        if (coverConfig?.position) {
          this.client?.subscribe(`ts-entities/${id}/position/set`);
        }
        if (coverConfig?.tilt) {
          this.client?.subscribe(`ts-entities/${id}/tilt/set`);
        }
      }

      // Climate needs separate command topics per feature
      if (entity.definition.type === 'climate') {
        this.client?.subscribe(`ts-entities/${id}/mode/set`);
        this.client?.subscribe(`ts-entities/${id}/temperature/set`);
        this.client?.subscribe(`ts-entities/${id}/temperature_high/set`);
        this.client?.subscribe(`ts-entities/${id}/temperature_low/set`);
        const climateConfig = (entity.definition as ClimateDefinition).config;
        if (climateConfig?.fan_modes) {
          this.client?.subscribe(`ts-entities/${id}/fan_mode/set`);
        }
        if (climateConfig?.swing_modes) {
          this.client?.subscribe(`ts-entities/${id}/swing_mode/set`);
        }
        if (climateConfig?.preset_modes) {
          this.client?.subscribe(`ts-entities/${id}/preset_mode/set`);
        }
      }
    }

    // Build and publish device discovery
    await this.publishDeviceDiscovery(entity);
  }

  async publishState(
    entityId: string,
    state: unknown,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    const entity = this.registeredEntities.get(entityId);
    const topic = `ts-entities/${entityId}/state`;

    let payload: string;

    // Complex entities (light, climate) use JSON state
    if (typeof state === 'object' && state !== null) {
      payload = JSON.stringify(
        attributes ? { ...state, ...attributes } : state,
      );
    } else if (attributes && Object.keys(attributes).length > 0) {
      payload = JSON.stringify({ state: String(state), ...attributes });
    } else {
      payload = String(state);
    }

    await this.publish(topic, payload, { retain: false });

    // Climate also publishes to individual state topics for HA compatibility
    if (entity?.definition.type === 'climate' && typeof state === 'object' && state !== null) {
      const cs = state as Record<string, unknown>;
      if (cs.mode !== undefined) {
        await this.publish(`ts-entities/${entityId}/mode/state`, String(cs.mode), { retain: false });
      }
      if (cs.temperature !== undefined) {
        await this.publish(`ts-entities/${entityId}/temperature/state`, String(cs.temperature), { retain: false });
      }
      if (cs.target_temp_high !== undefined) {
        await this.publish(`ts-entities/${entityId}/temperature_high/state`, String(cs.target_temp_high), { retain: false });
      }
      if (cs.target_temp_low !== undefined) {
        await this.publish(`ts-entities/${entityId}/temperature_low/state`, String(cs.target_temp_low), { retain: false });
      }
      if (cs.current_temperature !== undefined) {
        await this.publish(`ts-entities/${entityId}/current_temperature`, String(cs.current_temperature), { retain: false });
      }
      if (cs.fan_mode !== undefined) {
        await this.publish(`ts-entities/${entityId}/fan_mode/state`, String(cs.fan_mode), { retain: false });
      }
      if (cs.swing_mode !== undefined) {
        await this.publish(`ts-entities/${entityId}/swing_mode/state`, String(cs.swing_mode), { retain: false });
      }
      if (cs.preset_mode !== undefined) {
        await this.publish(`ts-entities/${entityId}/preset_mode/state`, String(cs.preset_mode), { retain: false });
      }
      if (cs.action !== undefined) {
        await this.publish(`ts-entities/${entityId}/action`, String(cs.action), { retain: false });
      }
    }
  }

  onCommand(entityId: string, handler: (command: unknown) => void): void {
    this.commandHandlers.set(entityId, handler);
  }

  async deregister(entityId: string): Promise<void> {
    const entity = this.registeredEntities.get(entityId);
    if (!entity) return;

    const id = entity.definition.id;

    // Unsubscribe from all command topics
    if ('onCommand' in entity.definition) {
      this.client?.unsubscribe(`ts-entities/${id}/set`);

      if (entity.definition.type === 'cover') {
        const coverConfig = (entity.definition as CoverDefinition).config;
        if (coverConfig?.position) this.client?.unsubscribe(`ts-entities/${id}/position/set`);
        if (coverConfig?.tilt) this.client?.unsubscribe(`ts-entities/${id}/tilt/set`);
      }

      if (entity.definition.type === 'climate') {
        this.client?.unsubscribe(`ts-entities/${id}/mode/set`);
        this.client?.unsubscribe(`ts-entities/${id}/temperature/set`);
        this.client?.unsubscribe(`ts-entities/${id}/temperature_high/set`);
        this.client?.unsubscribe(`ts-entities/${id}/temperature_low/set`);
        const climateConfig = (entity.definition as ClimateDefinition).config;
        if (climateConfig?.fan_modes) this.client?.unsubscribe(`ts-entities/${id}/fan_mode/set`);
        if (climateConfig?.swing_modes) this.client?.unsubscribe(`ts-entities/${id}/swing_mode/set`);
        if (climateConfig?.preset_modes) this.client?.unsubscribe(`ts-entities/${id}/preset_mode/set`);
      }
    }

    this.commandHandlers.delete(entityId);
    this.registeredEntities.delete(entityId);

    // Re-publish device config without this entity, or clear if last entity
    await this.removeFromDeviceDiscovery(entity);
  }

  async republishAll(): Promise<void> {
    // Re-publish availability
    await this.publishAvailability('online');

    // Re-subscribe to HA status
    this.subscribeHAStatus();

    // Re-publish all device discovery configs
    for (const [deviceId, config] of this.deviceConfigs) {
      const topic = `homeassistant/device/${deviceId}/config`;
      await this.publish(topic, JSON.stringify(config), { retain: true });
    }

    // Re-subscribe to command topics for all registered entities
    for (const [, entity] of this.registeredEntities) {
      if ('onCommand' in entity.definition) {
        const id = entity.definition.id;
        this.client?.subscribe(`ts-entities/${id}/set`);
      }
    }
  }

  /**
   * Record a failure for an entity. After maxFailures consecutive failures,
   * the entity is marked unavailable.
   */
  recordEntityFailure(entityId: string): void {
    const count = (this.entityFailures.get(entityId) ?? 0) + 1;
    this.entityFailures.set(entityId, count);

    if (count >= this.maxFailures && this.entityAvailability.get(entityId) !== false) {
      this.entityAvailability.set(entityId, false);
      // Publish entity-specific unavailability
      this.publish(
        `ts-entities/${entityId}/availability`,
        'offline',
        { retain: true },
      ).catch(() => {});
    }
  }

  /**
   * Clear failure count for an entity (e.g., after a successful state publish).
   */
  clearEntityFailure(entityId: string): void {
    const wasUnavailable = this.entityAvailability.get(entityId) === false;
    this.entityFailures.delete(entityId);
    this.entityAvailability.set(entityId, true);

    if (wasUnavailable) {
      this.publish(
        `ts-entities/${entityId}/availability`,
        'online',
        { retain: true },
      ).catch(() => {});
    }
  }

  isEntityAvailable(entityId: string): boolean {
    return this.entityAvailability.get(entityId) !== false;
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
      case 'light':
        this.applyLightConfig(base, definition as LightDefinition);
        break;
      case 'cover':
        this.applyCoverConfig(base, definition as CoverDefinition);
        break;
      case 'climate':
        this.applyClimateConfig(base, definition as ClimateDefinition);
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

  private applyLightConfig(base: Record<string, unknown>, def: LightDefinition): void {
    const config = def.config;
    if (!config) return;

    // Use JSON schema for clean command/state payloads
    base.schema = 'json';
    base.brightness = config.supported_color_modes.some(
      (m) => m !== 'onoff',
    );
    if (config.supported_color_modes.length > 0) {
      base.sup_clrm = config.supported_color_modes;
    }
    if (config.effect_list && config.effect_list.length > 0) {
      base.fx_list = config.effect_list;
    }
    if (config.min_color_temp_kelvin != null) {
      base.min_klv = config.min_color_temp_kelvin;
    }
    if (config.max_color_temp_kelvin != null) {
      base.max_klv = config.max_color_temp_kelvin;
    }
    // Use Kelvin for color temperature
    if (config.supported_color_modes.includes('color_temp')) {
      base.clr_temp_klv = true;
    }
  }

  private applyCoverConfig(base: Record<string, unknown>, def: CoverDefinition): void {
    const config = def.config;
    const id = def.id;

    if (config?.device_class) base.dev_cla = config.device_class;

    // Cover uses specific payloads for open/close/stop
    base.pl_open = 'OPEN';
    base.pl_cls = 'CLOSE';
    base.pl_stop = 'STOP';

    // State values
    base.stat_open = 'open';
    base.stat_opening = 'opening';
    base.stat_clsd = 'closed';
    base.stat_closing = 'closing';
    base.stat_stopped = 'stopped';

    // Position support
    if (config?.position) {
      base.pos_t = `ts-entities/${id}/position`;
      base.set_pos_t = `ts-entities/${id}/position/set`;
      base.pos_open = 100;
      base.pos_clsd = 0;
    }

    // Tilt support
    if (config?.tilt) {
      base.tilt_cmd_t = `ts-entities/${id}/tilt/set`;
      base.tilt_status_t = `ts-entities/${id}/tilt`;
    }
  }

  private applyClimateConfig(base: Record<string, unknown>, def: ClimateDefinition): void {
    const config = def.config!;
    const id = def.id;

    // Climate uses separate topics per feature (not the generic cmd_t)
    delete base.cmd_t;

    // Mode
    base.mode_cmd_t = `ts-entities/${id}/mode/set`;
    base.mode_stat_t = `ts-entities/${id}/mode/state`;
    base.modes = config.hvac_modes;

    // Temperature
    base.temp_cmd_t = `ts-entities/${id}/temperature/set`;
    base.temp_stat_t = `ts-entities/${id}/temperature/state`;
    base.curr_temp_t = `ts-entities/${id}/current_temperature`;

    // Dual setpoint
    base.temp_hi_cmd_t = `ts-entities/${id}/temperature_high/set`;
    base.temp_hi_stat_t = `ts-entities/${id}/temperature_high/state`;
    base.temp_lo_cmd_t = `ts-entities/${id}/temperature_low/set`;
    base.temp_lo_stat_t = `ts-entities/${id}/temperature_low/state`;

    if (config.min_temp != null) base.min_temp = config.min_temp;
    if (config.max_temp != null) base.max_temp = config.max_temp;
    if (config.temp_step != null) base.temp_step = config.temp_step;
    if (config.temperature_unit) base.temp_unit = config.temperature_unit;

    // Fan modes
    if (config.fan_modes && config.fan_modes.length > 0) {
      base.fan_mode_cmd_t = `ts-entities/${id}/fan_mode/set`;
      base.fan_mode_stat_t = `ts-entities/${id}/fan_mode/state`;
      base.fan_modes = config.fan_modes;
    }

    // Swing modes
    if (config.swing_modes && config.swing_modes.length > 0) {
      base.swing_mode_cmd_t = `ts-entities/${id}/swing_mode/set`;
      base.swing_mode_stat_t = `ts-entities/${id}/swing_mode/state`;
      base.swing_modes = config.swing_modes;
    }

    // Preset modes
    if (config.preset_modes && config.preset_modes.length > 0) {
      base.pr_mode_cmd_t = `ts-entities/${id}/preset_mode/set`;
      base.pr_mode_stat_t = `ts-entities/${id}/preset_mode/state`;
      base.pr_modes = config.preset_modes;
    }

    // Action topic
    base.act_t = `ts-entities/${id}/action`;
  }

  private handleMessage(topic: string, payload: string): void {
    // Handle HA restart
    if (topic === HA_STATUS_TOPIC && payload === 'online') {
      this.republishAll();
      return;
    }

    // Handle simple command: ts-entities/<entity_id>/set
    const simpleMatch = topic.match(/^ts-entities\/([^/]+)\/set$/);
    if (simpleMatch) {
      const entityId = simpleMatch[1];
      const handler = this.commandHandlers.get(entityId);
      if (handler) {
        try {
          handler(JSON.parse(payload));
        } catch {
          handler(payload);
        }
      }
      return;
    }

    // Handle cover position/tilt: ts-entities/<id>/position/set or ts-entities/<id>/tilt/set
    const coverPosMatch = topic.match(/^ts-entities\/([^/]+)\/(position|tilt)\/set$/);
    if (coverPosMatch) {
      const [, entityId, subCommand] = coverPosMatch;
      const handler = this.commandHandlers.get(entityId);
      if (handler) {
        const value = Number(payload);
        if (subCommand === 'position') {
          handler({ action: 'set_position', position: value });
        } else {
          handler({ action: 'set_tilt', tilt: value });
        }
      }
      return;
    }

    // Handle climate sub-topics: ts-entities/<id>/<feature>/set
    const climateMatch = topic.match(
      /^ts-entities\/([^/]+)\/(mode|temperature|temperature_high|temperature_low|fan_mode|swing_mode|preset_mode)\/set$/,
    );
    if (climateMatch) {
      const [, entityId, feature] = climateMatch;
      const handler = this.commandHandlers.get(entityId);
      if (handler) {
        const command: Record<string, unknown> = {};
        if (feature === 'temperature' || feature === 'temperature_high' || feature === 'temperature_low') {
          command[feature === 'temperature' ? 'temperature' : feature === 'temperature_high' ? 'target_temp_high' : 'target_temp_low'] = Number(payload);
        } else if (feature === 'mode') {
          command.hvac_mode = payload;
        } else {
          command[feature] = payload;
        }
        handler(command);
      }
      return;
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
