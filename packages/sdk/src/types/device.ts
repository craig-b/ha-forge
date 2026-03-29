import type { BinaryState, EntityContext, StatelessHAApi, EventsContext, EntityLogger, DeviceInfo } from './core.js';
import type { SensorDefinition, SensorStateFor, ComputedDefinition } from './sensor.js';
import type { BinarySensorDefinition } from './binary_sensor.js';
import type { SwitchDefinition } from './switch.js';
import type { LightDefinition, LightState, LightCommand } from './light.js';
import type { CoverDefinition, CoverState, CoverCommand } from './cover.js';
import type { ClimateDefinition, ClimateState, ClimateCommand } from './climate.js';
import type { FanDefinition, FanState, FanCommand } from './fan.js';
import type { LockDefinition, LockState, LockCommand } from './lock.js';
import type { NumberDefinition } from './number.js';
import type { SelectDefinition } from './select.js';
import type { TextDefinition } from './text.js';
import type { ButtonDefinition } from './button.js';
import type { SirenDefinition, SirenCommand } from './siren.js';
import type { HumidifierDefinition, HumidifierState, HumidifierCommand } from './humidifier.js';
import type { ValveDefinition, ValveState, ValveCommand } from './valve.js';
import type { WaterHeaterDefinition, WaterHeaterState, WaterHeaterCommand } from './water_heater.js';
import type { VacuumDefinition, VacuumState, VacuumCommand } from './vacuum.js';
import type { LawnMowerDefinition, LawnMowerActivity, LawnMowerCommand } from './lawn_mower.js';
import type { AlarmControlPanelDefinition, AlarmControlPanelState, AlarmControlPanelCommand } from './alarm_control_panel.js';
import type { NotifyDefinition } from './notify.js';
import type { UpdateDefinition, UpdateState } from './update.js';
import type { ImageDefinition } from './image.js';
import type { AutomationDefinition } from './automation.js';
import type { TaskDefinition } from './task.js';
import type { ModeDefinition } from './mode.js';
import type { CronDefinition } from './cron.js';

/** Union of all supported entity definition types. */
export type EntityDefinition =
  | SensorDefinition
  | ComputedDefinition
  | BinarySensorDefinition
  | SwitchDefinition
  | LightDefinition
  | CoverDefinition
  | ClimateDefinition
  | FanDefinition
  | LockDefinition
  | NumberDefinition
  | SelectDefinition
  | TextDefinition
  | ButtonDefinition
  | SirenDefinition
  | HumidifierDefinition
  | ValveDefinition
  | WaterHeaterDefinition
  | VacuumDefinition
  | LawnMowerDefinition
  | AlarmControlPanelDefinition
  | NotifyDefinition
  | UpdateDefinition
  | ImageDefinition;

/** Entity definitions that carry state — excludes button (command-only) and notify (write-only). */
export type StatefulEntityDefinition = Exclude<EntityDefinition, ButtonDefinition | NotifyDefinition>;

/**
 * A function that returns an array of entity definitions.
 * Use `entityFactory()` to create one when you need dynamic entity creation.
 */
export type EntityFactory = () => EntityDefinition[] | Promise<EntityDefinition[]>;

/**
 * Union of all definition types that can appear inside a device's `entities` map.
 */
export type DeviceMemberDefinition =
  | EntityDefinition
  | TaskDefinition
  | ModeDefinition<string>
  | CronDefinition
  | AutomationDefinition;

/**
 * Handle for updating an entity's state from within a device's `init()`.
 */
export interface DeviceEntityHandle<TState> {
  update(value: TState | null, attributes?: Record<string, unknown>): void;
}

/**
 * Handle for a bidirectional entity within a device.
 * Adds `onCommand()` registration to the base handle.
 */
export interface DeviceCommandEntityHandle<TState, TCommand> extends DeviceEntityHandle<TState> {
  onCommand(handler: (command: TCommand) => void | Promise<void>): void;
}

/**
 * Maps an entity definition type to its device handle type.
 */
export type EntityHandleFor<T extends EntityDefinition> =
  T extends SwitchDefinition ? DeviceCommandEntityHandle<BinaryState, 'ON' | 'OFF'> :
  T extends LightDefinition ? DeviceCommandEntityHandle<LightState, LightCommand> :
  T extends CoverDefinition ? DeviceCommandEntityHandle<CoverState, CoverCommand> :
  T extends ClimateDefinition ? DeviceCommandEntityHandle<ClimateState, ClimateCommand> :
  T extends FanDefinition ? DeviceCommandEntityHandle<FanState, FanCommand> :
  T extends LockDefinition ? DeviceCommandEntityHandle<LockState, LockCommand> :
  T extends NumberDefinition ? DeviceCommandEntityHandle<number, number> :
  T extends SelectDefinition ? DeviceCommandEntityHandle<string, string> :
  T extends TextDefinition ? DeviceCommandEntityHandle<string, string> :
  T extends SirenDefinition ? DeviceCommandEntityHandle<BinaryState, SirenCommand> :
  T extends HumidifierDefinition ? DeviceCommandEntityHandle<HumidifierState, HumidifierCommand> :
  T extends ValveDefinition ? DeviceCommandEntityHandle<ValveState, ValveCommand> :
  T extends WaterHeaterDefinition ? DeviceCommandEntityHandle<WaterHeaterState, WaterHeaterCommand> :
  T extends VacuumDefinition ? DeviceCommandEntityHandle<VacuumState, VacuumCommand> :
  T extends LawnMowerDefinition ? DeviceCommandEntityHandle<LawnMowerActivity, LawnMowerCommand> :
  T extends AlarmControlPanelDefinition ? DeviceCommandEntityHandle<AlarmControlPanelState, AlarmControlPanelCommand> :
  T extends SensorDefinition<infer DC> ? DeviceEntityHandle<SensorStateFor<DC>> :
  T extends BinarySensorDefinition ? DeviceEntityHandle<BinaryState> :
  T extends UpdateDefinition ? DeviceEntityHandle<UpdateState> :
  T extends ImageDefinition ? DeviceEntityHandle<string> :
  DeviceEntityHandle<unknown>;

/** Handle for triggering a task from within a device's `init()`. */
export interface DeviceTaskHandle {
  trigger(): void;
}

/** Handle for reading/setting a mode's state from within a device's `init()`. */
export interface DeviceModeHandle<TStates extends string = string> {
  readonly state: TStates;
  setState(state: TStates): Promise<void>;
}

/** Handle for reading a cron's active state from within a device's `init()`. */
export interface DeviceCronHandle {
  readonly isActive: boolean;
}

/** Handle for an automation within a device. */
export interface DeviceAutomationHandle {}

/**
 * Maps a device member definition type to its device handle type.
 */
export type DeviceMemberHandleFor<T extends DeviceMemberDefinition> =
  T extends TaskDefinition ? DeviceTaskHandle :
  T extends ModeDefinition<infer TStates> ? DeviceModeHandle<TStates> :
  T extends CronDefinition ? DeviceCronHandle :
  T extends AutomationDefinition ? DeviceAutomationHandle :
  T extends EntityDefinition ? EntityHandleFor<T> :
  never;

/**
 * Context bound as `this` inside a device's `init()` and `destroy()` callbacks.
 */
export interface DeviceContext<TEntities extends Record<string, DeviceMemberDefinition>> {
  entities: { [K in keyof TEntities]: DeviceMemberHandleFor<TEntities[K]> };
  ha: StatelessHAApi;
  events: EventsContext;
  poll(fn: () => void | Promise<void>, opts: { interval: number; fireImmediately?: boolean }): void;
  poll(fn: () => void | Promise<void>, opts: { cron: string; fireImmediately?: boolean }): void;
  log: EntityLogger;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  mqtt: {
    publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
    subscribe(topic: string, handler: (payload: string) => void): void;
  };
}

/**
 * Options for defining a device with grouped entities.
 */
export interface DeviceOptions<TEntities extends Record<string, DeviceMemberDefinition>> {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  sw_version?: string;
  suggested_area?: string;
  entities: TEntities;
  init?(this: DeviceContext<TEntities>): void | Promise<void>;
  destroy?(this: DeviceContext<TEntities>): void | Promise<void>;
}

/**
 * A device definition that groups multiple entities with a shared lifecycle.
 * Created by the `device()` factory function.
 */
export interface DeviceDefinition<TEntities extends Record<string, DeviceMemberDefinition> = Record<string, DeviceMemberDefinition>> {
  __kind: 'device';
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  sw_version?: string;
  suggested_area?: string;
  entities: TEntities;
  init?(this: DeviceContext<TEntities>): void | Promise<void>;
  destroy?(this: DeviceContext<TEntities>): void | Promise<void>;
}
