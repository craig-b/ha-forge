import mqtt from 'mqtt';
import type {
  EntityType,
  SensorDefinition,
  BinarySensorDefinition,
  SwitchDefinition,
  LightDefinition,
  CoverDefinition,
  ClimateDefinition,
  FanDefinition,
  LockDefinition,
  NumberDefinition,
  SelectDefinition,
  TextDefinition,
  ButtonDefinition,
  SirenDefinition,
  HumidifierDefinition,
  ValveDefinition,
  WaterHeaterDefinition,
  VacuumDefinition,
  LawnMowerDefinition,
  AlarmControlPanelDefinition,
  NotifyDefinition,
  UpdateDefinition,
  ImageDefinition,
} from '@ha-forge/sdk';
import type { ResolvedEntity } from '@ha-forge/sdk/internal';
import type { Transport } from './transport.js';

const AVAILABILITY_TOPIC = 'ha-forge/availability';
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
    this.subscribeCommandTopics(entity);

    // Build and publish device discovery
    await this.publishDeviceDiscovery(entity);
  }

  async publishState(
    entityId: string,
    state: unknown,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    const entity = this.registeredEntities.get(entityId);
    const topic = `ha-forge/${entityId}/state`;

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

    if (entity && typeof state === 'object' && state !== null) {
      const cs = state as Record<string, unknown>;
      const type = entity.definition.type;

      // Climate publishes to individual state topics for HA compatibility
      if (type === 'climate') {
        if (cs.mode !== undefined) await this.publish(`ha-forge/${entityId}/mode/state`, String(cs.mode), { retain: false });
        if (cs.temperature !== undefined) await this.publish(`ha-forge/${entityId}/temperature/state`, String(cs.temperature), { retain: false });
        if (cs.target_temp_high !== undefined) await this.publish(`ha-forge/${entityId}/temperature_high/state`, String(cs.target_temp_high), { retain: false });
        if (cs.target_temp_low !== undefined) await this.publish(`ha-forge/${entityId}/temperature_low/state`, String(cs.target_temp_low), { retain: false });
        if (cs.current_temperature !== undefined) await this.publish(`ha-forge/${entityId}/current_temperature`, String(cs.current_temperature), { retain: false });
        if (cs.fan_mode !== undefined) await this.publish(`ha-forge/${entityId}/fan_mode/state`, String(cs.fan_mode), { retain: false });
        if (cs.swing_mode !== undefined) await this.publish(`ha-forge/${entityId}/swing_mode/state`, String(cs.swing_mode), { retain: false });
        if (cs.preset_mode !== undefined) await this.publish(`ha-forge/${entityId}/preset_mode/state`, String(cs.preset_mode), { retain: false });
        if (cs.action !== undefined) await this.publish(`ha-forge/${entityId}/action`, String(cs.action), { retain: false });
      }

      // Fan publishes to individual state topics
      if (type === 'fan') {
        if (cs.percentage !== undefined) await this.publish(`ha-forge/${entityId}/percentage/state`, String(cs.percentage), { retain: false });
        if (cs.oscillation !== undefined) await this.publish(`ha-forge/${entityId}/oscillation/state`, cs.oscillation === 'on' ? 'oscillate_on' : 'oscillate_off', { retain: false });
        if (cs.direction !== undefined) await this.publish(`ha-forge/${entityId}/direction/state`, String(cs.direction), { retain: false });
        if (cs.preset_mode !== undefined) await this.publish(`ha-forge/${entityId}/preset_mode/state`, String(cs.preset_mode), { retain: false });
      }

      // Humidifier publishes to individual state topics
      if (type === 'humidifier') {
        if (cs.humidity !== undefined) await this.publish(`ha-forge/${entityId}/humidity/state`, String(cs.humidity), { retain: false });
        if (cs.current_humidity !== undefined) await this.publish(`ha-forge/${entityId}/current_humidity`, String(cs.current_humidity), { retain: false });
        if (cs.mode !== undefined) await this.publish(`ha-forge/${entityId}/mode/state`, String(cs.mode), { retain: false });
        if (cs.action !== undefined) await this.publish(`ha-forge/${entityId}/action`, String(cs.action), { retain: false });
      }

      // Water heater publishes to individual state topics
      if (type === 'water_heater') {
        if (cs.mode !== undefined) await this.publish(`ha-forge/${entityId}/mode/state`, String(cs.mode), { retain: false });
        if (cs.temperature !== undefined) await this.publish(`ha-forge/${entityId}/temperature/state`, String(cs.temperature), { retain: false });
        if (cs.current_temperature !== undefined) await this.publish(`ha-forge/${entityId}/current_temperature`, String(cs.current_temperature), { retain: false });
      }

      // Update publishes latest_version separately
      if (type === 'update') {
        if (cs.latest_version !== undefined) await this.publish(`ha-forge/${entityId}/latest_version`, String(cs.latest_version ?? ''), { retain: false });
      }
    }

    // Lawn mower publishes activity to its own topic
    if (entity?.definition.type === 'lawn_mower' && typeof state === 'string') {
      await this.publish(`ha-forge/${entityId}/activity`, state, { retain: false });
    }

    // Image publishes URL to its own topic
    if (entity?.definition.type === 'image' && typeof state === 'string') {
      await this.publish(`ha-forge/${entityId}/url`, state, { retain: false });
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
    const isBidirectional = 'onCommand' in entity.definition || 'onPress' in entity.definition || 'onNotify' in entity.definition || 'onInstall' in entity.definition || entity.definition.type === 'button' || entity.definition.type === 'select';
    if (isBidirectional) {
      this.client?.unsubscribe(`ha-forge/${id}/set`);

      if (entity.definition.type === 'cover') {
        const coverConfig = (entity.definition as CoverDefinition).config;
        if (coverConfig?.position) this.client?.unsubscribe(`ha-forge/${id}/position/set`);
        if (coverConfig?.tilt) this.client?.unsubscribe(`ha-forge/${id}/tilt/set`);
      }

      if (entity.definition.type === 'climate') {
        this.client?.unsubscribe(`ha-forge/${id}/mode/set`);
        this.client?.unsubscribe(`ha-forge/${id}/temperature/set`);
        this.client?.unsubscribe(`ha-forge/${id}/temperature_high/set`);
        this.client?.unsubscribe(`ha-forge/${id}/temperature_low/set`);
        const climateConfig = (entity.definition as ClimateDefinition).config;
        if (climateConfig?.fan_modes) this.client?.unsubscribe(`ha-forge/${id}/fan_mode/set`);
        if (climateConfig?.swing_modes) this.client?.unsubscribe(`ha-forge/${id}/swing_mode/set`);
        if (climateConfig?.preset_modes) this.client?.unsubscribe(`ha-forge/${id}/preset_mode/set`);
      }

      if (entity.definition.type === 'fan') {
        this.client?.unsubscribe(`ha-forge/${id}/percentage/set`);
        this.client?.unsubscribe(`ha-forge/${id}/oscillation/set`);
        this.client?.unsubscribe(`ha-forge/${id}/direction/set`);
        const fanConfig = (entity.definition as FanDefinition).config;
        if (fanConfig?.preset_modes) this.client?.unsubscribe(`ha-forge/${id}/preset_mode/set`);
      }

      if (entity.definition.type === 'humidifier') {
        this.client?.unsubscribe(`ha-forge/${id}/humidity/set`);
        const humConfig = (entity.definition as HumidifierDefinition).config;
        if (humConfig?.modes) this.client?.unsubscribe(`ha-forge/${id}/mode/set`);
      }

      if (entity.definition.type === 'water_heater') {
        this.client?.unsubscribe(`ha-forge/${id}/mode/set`);
        this.client?.unsubscribe(`ha-forge/${id}/temperature/set`);
      }

      if (entity.definition.type === 'valve') {
        const valveConfig = (entity.definition as ValveDefinition).config;
        if (valveConfig?.reports_position) this.client?.unsubscribe(`ha-forge/${id}/position/set`);
      }

      if (entity.definition.type === 'vacuum') {
        this.client?.unsubscribe(`ha-forge/${id}/command`);
        const vacConfig = (entity.definition as VacuumDefinition).config;
        if (vacConfig?.fan_speed_list) this.client?.unsubscribe(`ha-forge/${id}/fan_speed/set`);
      }

      if (entity.definition.type === 'lawn_mower') {
        this.client?.unsubscribe(`ha-forge/${id}/start_mowing`);
        this.client?.unsubscribe(`ha-forge/${id}/pause`);
        this.client?.unsubscribe(`ha-forge/${id}/dock`);
      }

      if (entity.definition.type === 'update' && 'onInstall' in entity.definition) {
        this.client?.unsubscribe(`ha-forge/${id}/install`);
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
      this.subscribeCommandTopics(entity);
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
        `ha-forge/${entityId}/availability`,
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
        `ha-forge/${entityId}/availability`,
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

  /** Subscribe to all command topics needed by this entity. */
  private subscribeCommandTopics(entity: ResolvedEntity): void {
    const { definition } = entity;
    const id = definition.id;

    // Check both marker properties (onCommand/onPress) and type (button/select always need commands)
    const isBidirectional = 'onCommand' in definition || 'onPress' in definition || 'onNotify' in definition || 'onInstall' in definition || definition.type === 'button' || definition.type === 'select';
    if (!isBidirectional) return;

    this.client?.subscribe(`ha-forge/${id}/set`);

    // Cover needs additional position/tilt command topics
    if (definition.type === 'cover') {
      const coverConfig = (definition as CoverDefinition).config;
      if (coverConfig?.position) {
        this.client?.subscribe(`ha-forge/${id}/position/set`);
      }
      if (coverConfig?.tilt) {
        this.client?.subscribe(`ha-forge/${id}/tilt/set`);
      }
    }

    // Climate needs separate command topics per feature
    if (definition.type === 'climate') {
      this.client?.subscribe(`ha-forge/${id}/mode/set`);
      this.client?.subscribe(`ha-forge/${id}/temperature/set`);
      this.client?.subscribe(`ha-forge/${id}/temperature_high/set`);
      this.client?.subscribe(`ha-forge/${id}/temperature_low/set`);
      const climateConfig = (definition as ClimateDefinition).config;
      if (climateConfig?.fan_modes) {
        this.client?.subscribe(`ha-forge/${id}/fan_mode/set`);
      }
      if (climateConfig?.swing_modes) {
        this.client?.subscribe(`ha-forge/${id}/swing_mode/set`);
      }
      if (climateConfig?.preset_modes) {
        this.client?.subscribe(`ha-forge/${id}/preset_mode/set`);
      }
    }

    // Fan needs separate command topics per feature
    if (definition.type === 'fan') {
      this.client?.subscribe(`ha-forge/${id}/percentage/set`);
      this.client?.subscribe(`ha-forge/${id}/oscillation/set`);
      this.client?.subscribe(`ha-forge/${id}/direction/set`);
      const fanConfig = (definition as FanDefinition).config;
      if (fanConfig?.preset_modes) {
        this.client?.subscribe(`ha-forge/${id}/preset_mode/set`);
      }
    }

    // Humidifier needs separate command topics
    if (definition.type === 'humidifier') {
      this.client?.subscribe(`ha-forge/${id}/humidity/set`);
      const humConfig = (definition as HumidifierDefinition).config;
      if (humConfig?.modes) {
        this.client?.subscribe(`ha-forge/${id}/mode/set`);
      }
    }

    // Water heater uses separate topics per feature
    if (definition.type === 'water_heater') {
      this.client?.subscribe(`ha-forge/${id}/mode/set`);
      this.client?.subscribe(`ha-forge/${id}/temperature/set`);
    }

    // Valve position control
    if (definition.type === 'valve') {
      const valveConfig = (definition as ValveDefinition).config;
      if (valveConfig?.reports_position) {
        this.client?.subscribe(`ha-forge/${id}/position/set`);
      }
    }

    // Vacuum fan speed
    if (definition.type === 'vacuum') {
      this.client?.subscribe(`ha-forge/${id}/command`);
      const vacConfig = (definition as VacuumDefinition).config;
      if (vacConfig?.fan_speed_list) {
        this.client?.subscribe(`ha-forge/${id}/fan_speed/set`);
      }
    }

    // Lawn mower uses separate command topics
    if (definition.type === 'lawn_mower') {
      this.client?.subscribe(`ha-forge/${id}/start_mowing`);
      this.client?.subscribe(`ha-forge/${id}/pause`);
      this.client?.subscribe(`ha-forge/${id}/dock`);
    }

    // Update install command
    if (definition.type === 'update' && 'onInstall' in definition) {
      this.client?.subscribe(`ha-forge/${id}/install`);
    }
  }

  private async publishDeviceDiscovery(entity: ResolvedEntity): Promise<void> {
    const { definition, deviceId } = entity;

    // Build or update device config
    let config = this.deviceConfigs.get(deviceId);
    if (!config) {
      config = {
        dev: this.buildDeviceInfo(entity),
        o: {
          name: 'ha-forge',
          sw: ADDON_VERSION,
          url: 'https://github.com/craig-b/ha-forge',
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
        ids: [`ha_forge_${dev.id}`],
        name: dev.name,
        ...(dev.manufacturer && { mf: dev.manufacturer }),
        ...(dev.model && { mdl: dev.model }),
        ...(dev.sw_version && { sw: dev.sw_version }),
        ...(dev.suggested_area && { sa: dev.suggested_area }),
      };
    }

    // Synthetic device from file grouping
    return {
      ids: [`ha_forge_${entity.deviceId}`],
      name: entity.deviceId,
      mf: 'ha-forge',
      mdl: 'User Script',
      sw: ADDON_VERSION,
    };
  }

  private buildComponentConfig(entity: ResolvedEntity): Record<string, unknown> {
    const { definition } = entity;
    const stateTopic = `ha-forge/${definition.id}/state`;

    const base: Record<string, unknown> = {
      p: definition.type,
      uniq_id: `ha_forge_${definition.id}`,
      name: definition.name,
      def_ent_id: `${definition.type}.${definition.id}`,
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
      base.cmd_t = `ha-forge/${definition.id}/set`;
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
      case 'fan':
        this.applyFanConfig(base, definition as FanDefinition);
        break;
      case 'lock':
        this.applyLockConfig(base, definition as LockDefinition);
        break;
      case 'number':
        this.applyNumberConfig(base, definition as NumberDefinition);
        break;
      case 'select':
        this.applySelectConfig(base, definition as SelectDefinition);
        break;
      case 'text':
        this.applyTextConfig(base, definition as TextDefinition);
        break;
      case 'button':
        this.applyButtonConfig(base, definition as ButtonDefinition);
        break;
      case 'siren':
        this.applySirenConfig(base, definition as SirenDefinition);
        break;
      case 'humidifier':
        this.applyHumidifierConfig(base, definition as HumidifierDefinition);
        break;
      case 'valve':
        this.applyValveConfig(base, definition as ValveDefinition);
        break;
      case 'water_heater':
        this.applyWaterHeaterConfig(base, definition as WaterHeaterDefinition);
        break;
      case 'vacuum':
        this.applyVacuumConfig(base, definition as VacuumDefinition);
        break;
      case 'lawn_mower':
        this.applyLawnMowerConfig(base, definition as LawnMowerDefinition);
        break;
      case 'alarm_control_panel':
        this.applyAlarmControlPanelConfig(base, definition as AlarmControlPanelDefinition);
        break;
      case 'notify':
        this.applyNotifyConfig(base, definition as NotifyDefinition);
        break;
      case 'update':
        this.applyUpdateConfig(base, definition as UpdateDefinition);
        break;
      case 'image':
        this.applyImageConfig(base, definition as ImageDefinition);
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
      base.pos_t = `ha-forge/${id}/position`;
      base.set_pos_t = `ha-forge/${id}/position/set`;
      base.pos_open = 100;
      base.pos_clsd = 0;
    }

    // Tilt support
    if (config?.tilt) {
      base.tilt_cmd_t = `ha-forge/${id}/tilt/set`;
      base.tilt_status_t = `ha-forge/${id}/tilt`;
    }
  }

  private applyClimateConfig(base: Record<string, unknown>, def: ClimateDefinition): void {
    const config = def.config!;
    const id = def.id;

    // Climate uses separate topics per feature (not the generic cmd_t)
    delete base.cmd_t;

    // Mode
    base.mode_cmd_t = `ha-forge/${id}/mode/set`;
    base.mode_stat_t = `ha-forge/${id}/mode/state`;
    base.modes = config.hvac_modes;

    // Temperature
    base.temp_cmd_t = `ha-forge/${id}/temperature/set`;
    base.temp_stat_t = `ha-forge/${id}/temperature/state`;
    base.curr_temp_t = `ha-forge/${id}/current_temperature`;

    // Dual setpoint
    base.temp_hi_cmd_t = `ha-forge/${id}/temperature_high/set`;
    base.temp_hi_stat_t = `ha-forge/${id}/temperature_high/state`;
    base.temp_lo_cmd_t = `ha-forge/${id}/temperature_low/set`;
    base.temp_lo_stat_t = `ha-forge/${id}/temperature_low/state`;

    if (config.min_temp != null) base.min_temp = config.min_temp;
    if (config.max_temp != null) base.max_temp = config.max_temp;
    if (config.temp_step != null) base.temp_step = config.temp_step;
    if (config.temperature_unit) base.temp_unit = config.temperature_unit;

    // Fan modes
    if (config.fan_modes && config.fan_modes.length > 0) {
      base.fan_mode_cmd_t = `ha-forge/${id}/fan_mode/set`;
      base.fan_mode_stat_t = `ha-forge/${id}/fan_mode/state`;
      base.fan_modes = config.fan_modes;
    }

    // Swing modes
    if (config.swing_modes && config.swing_modes.length > 0) {
      base.swing_mode_cmd_t = `ha-forge/${id}/swing_mode/set`;
      base.swing_mode_stat_t = `ha-forge/${id}/swing_mode/state`;
      base.swing_modes = config.swing_modes;
    }

    // Preset modes
    if (config.preset_modes && config.preset_modes.length > 0) {
      base.pr_mode_cmd_t = `ha-forge/${id}/preset_mode/set`;
      base.pr_mode_stat_t = `ha-forge/${id}/preset_mode/state`;
      base.pr_modes = config.preset_modes;
    }

    // Action topic
    base.act_t = `ha-forge/${id}/action`;
  }

  private applyFanConfig(base: Record<string, unknown>, def: FanDefinition): void {
    const config = def.config;
    const id = def.id;

    // Fan uses JSON schema for clean command/state payloads
    base.schema = 'json';

    // Percentage support via separate topics
    base.pct_cmd_t = `ha-forge/${id}/percentage/set`;
    base.pct_stat_t = `ha-forge/${id}/percentage/state`;

    // Oscillation
    base.osc_cmd_t = `ha-forge/${id}/oscillation/set`;
    base.osc_stat_t = `ha-forge/${id}/oscillation/state`;

    // Direction
    base.dir_cmd_t = `ha-forge/${id}/direction/set`;
    base.dir_stat_t = `ha-forge/${id}/direction/state`;

    if (config?.preset_modes && config.preset_modes.length > 0) {
      base.pr_mode_cmd_t = `ha-forge/${id}/preset_mode/set`;
      base.pr_mode_stat_t = `ha-forge/${id}/preset_mode/state`;
      base.pr_modes = config.preset_modes;
    }

    if (config?.speed_range_min != null) base.spd_rng_min = config.speed_range_min;
    if (config?.speed_range_max != null) base.spd_rng_max = config.speed_range_max;
  }

  private applyLockConfig(base: Record<string, unknown>, def: LockDefinition): void {
    const config = def.config;
    base.stat_locked = 'locked';
    base.stat_locking = 'locking';
    base.stat_unlocked = 'unlocked';
    base.stat_unlocking = 'unlocking';
    base.stat_jammed = 'jammed';
    base.pl_lock = 'LOCK';
    base.pl_unlk = 'UNLOCK';
    base.pl_open = 'OPEN';
    if (config?.code_format) base.code_format = config.code_format;
  }

  private applyNumberConfig(base: Record<string, unknown>, def: NumberDefinition): void {
    const config = def.config;
    if (!config) return;
    if (config.device_class) base.dev_cla = config.device_class;
    if (config.min != null) base.min = config.min;
    if (config.max != null) base.max = config.max;
    if (config.step != null) base.step = config.step;
    if (config.unit_of_measurement) base.unit_of_meas = config.unit_of_measurement;
    if (config.mode) base.mode = config.mode;
  }

  private applySelectConfig(base: Record<string, unknown>, def: SelectDefinition): void {
    const config = def.config;
    // Select always needs a command topic for option selection
    base.cmd_t = `ha-forge/${def.id}/set`;
    if (config?.options) base.options = config.options;
  }

  private applyTextConfig(base: Record<string, unknown>, def: TextDefinition): void {
    const config = def.config;
    if (!config) return;
    if (config.min != null) base.min = config.min;
    if (config.max != null) base.max = config.max;
    if (config.pattern) base.pattern = config.pattern;
    if (config.mode) base.mode = config.mode;
  }

  private applyButtonConfig(base: Record<string, unknown>, def: ButtonDefinition): void {
    const config = def.config;
    // Button has no state topic — remove it
    delete base.stat_t;
    // Button always needs a command topic for press events
    base.cmd_t = `ha-forge/${def.id}/set`;
    base.pl_prs = 'PRESS';
    if (config?.device_class) base.dev_cla = config.device_class;
  }

  private applySirenConfig(base: Record<string, unknown>, def: SirenDefinition): void {
    const config = def.config;
    // Siren uses JSON commands when tones/volume/duration are supported
    if (config?.available_tones && config.available_tones.length > 0) {
      base.available_tones = config.available_tones;
    }
    if (config?.support_duration) base.support_duration = true;
    if (config?.support_volume_set) base.support_volume_set = true;
  }

  private applyHumidifierConfig(base: Record<string, unknown>, def: HumidifierDefinition): void {
    const config = def.config;
    const id = def.id;

    if (config?.device_class) base.dev_cla = config.device_class;

    // Humidity target via separate topics
    base.tgt_hum_cmd_t = `ha-forge/${id}/humidity/set`;
    base.tgt_hum_stat_t = `ha-forge/${id}/humidity/state`;
    base.curr_hum_t = `ha-forge/${id}/current_humidity`;
    base.act_t = `ha-forge/${id}/action`;

    if (config?.min_humidity != null) base.min_hum = config.min_humidity;
    if (config?.max_humidity != null) base.max_hum = config.max_humidity;

    if (config?.modes && config.modes.length > 0) {
      base.mode_cmd_t = `ha-forge/${id}/mode/set`;
      base.mode_stat_t = `ha-forge/${id}/mode/state`;
      base.modes = config.modes;
    }
  }

  private applyValveConfig(base: Record<string, unknown>, def: ValveDefinition): void {
    const config = def.config;
    const id = def.id;

    if (config?.device_class) base.dev_cla = config.device_class;

    base.pl_open = 'OPEN';
    base.pl_cls = 'CLOSE';
    base.pl_stop = 'STOP';
    base.stat_open = 'open';
    base.stat_opening = 'opening';
    base.stat_clsd = 'closed';
    base.stat_closing = 'closing';

    if (config?.reports_position) {
      base.pos_t = `ha-forge/${id}/position`;
      base.set_pos_t = `ha-forge/${id}/position/set`;
      base.rpts_pos = true;
    }
  }

  private applyWaterHeaterConfig(base: Record<string, unknown>, def: WaterHeaterDefinition): void {
    const config = def.config!;
    const id = def.id;

    // Water heater uses separate topics per feature (like climate)
    delete base.cmd_t;

    base.mode_cmd_t = `ha-forge/${id}/mode/set`;
    base.mode_stat_t = `ha-forge/${id}/mode/state`;
    base.modes = config.modes;

    base.temp_cmd_t = `ha-forge/${id}/temperature/set`;
    base.temp_stat_t = `ha-forge/${id}/temperature/state`;
    base.curr_temp_t = `ha-forge/${id}/current_temperature`;

    if (config.min_temp != null) base.min_temp = config.min_temp;
    if (config.max_temp != null) base.max_temp = config.max_temp;
    if (config.precision != null) base.precision = config.precision;
    if (config.temperature_unit) base.temp_unit = config.temperature_unit;
  }

  private applyVacuumConfig(base: Record<string, unknown>, def: VacuumDefinition): void {
    const config = def.config;
    const id = def.id;

    // Vacuum uses JSON state topic
    base.schema = 'state';
    const supFeat = ['start', 'pause', 'stop', 'return_home', 'clean_spot', 'locate'];

    if (config?.fan_speed_list && config.fan_speed_list.length > 0) {
      base.fanspd_lst = config.fan_speed_list;
      base.set_fan_spd_t = `ha-forge/${id}/fan_speed/set`;
      supFeat.push('fan_speed');
    }

    base.sup_feat = supFeat;

    base.send_cmd_t = `ha-forge/${id}/command`;
  }

  private applyLawnMowerConfig(base: Record<string, unknown>, def: LawnMowerDefinition): void {
    const id = def.id;

    // Lawn mower uses separate command topics and an activity state topic
    delete base.cmd_t;
    delete base.stat_t;

    base.act_stat_t = `ha-forge/${id}/activity`;
    base.start_mowing_cmd_t = `ha-forge/${id}/start_mowing`;
    base.pause_cmd_t = `ha-forge/${id}/pause`;
    base.dock_cmd_t = `ha-forge/${id}/dock`;
  }

  private applyAlarmControlPanelConfig(base: Record<string, unknown>, def: AlarmControlPanelDefinition): void {
    const config = def.config;
    if (config?.code_arm_required != null) base.cod_arm_req = config.code_arm_required;
    if (config?.code_disarm_required != null) base.cod_dis_req = config.code_disarm_required;
    if (config?.code_trigger_required != null) base.cod_trig_req = config.code_trigger_required;
  }

  private applyNotifyConfig(base: Record<string, unknown>, _def: NotifyDefinition): void {
    // Notify has no state topic — write-only
    delete base.stat_t;
  }

  private applyUpdateConfig(base: Record<string, unknown>, def: UpdateDefinition): void {
    const config = def.config;
    const id = def.id;

    if (config?.device_class) base.dev_cla = config.device_class;

    // Update uses JSON state and a separate latest version topic
    base.l_ver_t = `ha-forge/${id}/latest_version`;

    // Install command topic if onInstall is defined
    if (def.onInstall) {
      base.cmd_t = `ha-forge/${id}/install`;
    }
  }

  private applyImageConfig(base: Record<string, unknown>, def: ImageDefinition): void {
    const config = def.config;
    // Image uses url_topic instead of state_topic
    delete base.stat_t;
    base.url_t = `ha-forge/${def.id}/url`;
    if (config?.content_type) base.cont_type = config.content_type;
  }

  private handleMessage(topic: string, payload: string): void {
    // Handle HA restart
    if (topic === HA_STATUS_TOPIC && payload === 'online') {
      this.republishAll();
      return;
    }

    // Handle simple command: ha-forge/<entity_id>/set
    const simpleMatch = topic.match(/^ha-forge\/([^/]+)\/set$/);
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

    // Handle cover/valve position/tilt: ha-forge/<id>/position/set or ha-forge/<id>/tilt/set
    const posMatch = topic.match(/^ha-forge\/([^/]+)\/(position|tilt)\/set$/);
    if (posMatch) {
      const [, entityId, subCommand] = posMatch;
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

    // Handle sub-topic commands: ha-forge/<id>/<feature>/set
    // Covers climate, fan, humidifier, water heater features
    const subTopicMatch = topic.match(
      /^ha-forge\/([^/]+)\/(mode|temperature|temperature_high|temperature_low|fan_mode|swing_mode|preset_mode|percentage|oscillation|direction|humidity|fan_speed)\/set$/,
    );
    if (subTopicMatch) {
      const [, entityId, feature] = subTopicMatch;
      const handler = this.commandHandlers.get(entityId);
      if (!handler) return;

      const entity = this.registeredEntities.get(entityId);
      const type = entity?.definition.type;

      // Climate commands
      if (type === 'climate') {
        const command: Record<string, unknown> = {};
        if (feature === 'temperature' || feature === 'temperature_high' || feature === 'temperature_low') {
          command[feature === 'temperature' ? 'temperature' : feature === 'temperature_high' ? 'target_temp_high' : 'target_temp_low'] = Number(payload);
        } else if (feature === 'mode') {
          command.hvac_mode = payload;
        } else {
          command[feature] = payload;
        }
        handler(command);
        return;
      }

      // Fan commands
      if (type === 'fan') {
        const command: Record<string, unknown> = {};
        if (feature === 'percentage') {
          command.percentage = Number(payload);
        } else if (feature === 'oscillation') {
          command.oscillation = payload;
        } else if (feature === 'direction') {
          command.direction = payload;
        } else if (feature === 'preset_mode') {
          command.preset_mode = payload;
        }
        handler(command);
        return;
      }

      // Humidifier commands
      if (type === 'humidifier') {
        const command: Record<string, unknown> = {};
        if (feature === 'humidity') {
          command.humidity = Number(payload);
        } else if (feature === 'mode') {
          command.mode = payload;
        }
        handler(command);
        return;
      }

      // Water heater commands
      if (type === 'water_heater') {
        const command: Record<string, unknown> = {};
        if (feature === 'mode') {
          command.mode = payload;
        } else if (feature === 'temperature') {
          command.temperature = Number(payload);
        }
        handler(command);
        return;
      }

      // Vacuum fan speed
      if (type === 'vacuum' && feature === 'fan_speed') {
        handler({ action: 'set_fan_speed', fan_speed: payload });
        return;
      }

      return;
    }

    // Handle vacuum command topic: ha-forge/<id>/command
    const vacuumMatch = topic.match(/^ha-forge\/([^/]+)\/command$/);
    if (vacuumMatch) {
      const entityId = vacuumMatch[1];
      const handler = this.commandHandlers.get(entityId);
      if (handler) {
        handler({ action: payload });
      }
      return;
    }

    // Handle lawn mower commands: ha-forge/<id>/(start_mowing|pause|dock)
    const lawnMowerMatch = topic.match(/^ha-forge\/([^/]+)\/(start_mowing|pause|dock)$/);
    if (lawnMowerMatch) {
      const [, entityId, action] = lawnMowerMatch;
      const handler = this.commandHandlers.get(entityId);
      if (handler) {
        handler(action);
      }
      return;
    }

    // Handle update install: ha-forge/<id>/install
    const installMatch = topic.match(/^ha-forge\/([^/]+)\/install$/);
    if (installMatch) {
      const entityId = installMatch[1];
      const handler = this.commandHandlers.get(entityId);
      if (handler) {
        handler('install');
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

  /**
   * Publish a message to an arbitrary MQTT topic.
   * For use by entity context `mqtt.publish()`.
   */
  publishRaw(topic: string, payload: string, opts?: { retain?: boolean }): void {
    if (!this.client?.connected) return;
    this.client.publish(topic, payload, { qos: 1, retain: opts?.retain ?? false });
  }

  /**
   * Subscribe to an arbitrary MQTT topic.
   * Returns an unsubscribe function. For use by entity context `mqtt.subscribe()`.
   */
  subscribeRaw(topic: string, handler: (payload: string) => void): () => void {
    if (!this.client) return () => {};

    const listener = (receivedTopic: string, message: Buffer) => {
      if (receivedTopic === topic) {
        handler(message.toString());
      }
    };

    this.client.subscribe(topic);
    this.client.on('message', listener);

    return () => {
      this.client?.unsubscribe(topic);
      this.client?.removeListener('message', listener);
    };
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
