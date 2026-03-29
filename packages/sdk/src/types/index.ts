// Core infrastructure types
export type {
  NumberInRange,
  EntityType,
  DeviceInfo,
  EntityLogger,
  StateChangedEvent,
  TypedStateChangedEvent,
  StateChangedCallback,
  Subscription,
  EventStream,
  ReactionRule,
  WatchdogExpect,
  WatchdogRule,
  ScheduleOptions,
  InvariantOptions,
  SequenceStep,
  SequenceOptions,
  EntitySnapshot,
  ComputedAttribute,
  CombinedState,
  CombinedCallback,
  HAClientBase,
  EventsContext,
  StatelessHAApi,
  HistoryApi,
  EntityContext,
  BaseEntity,
  BinaryState,
} from './core.js';

// Simulation types
export type {
  SignalEvent,
  TimeRange,
  SignalGenerator,
  ScenarioDefinition,
} from './simulation.js';

// Entity platform types
export type { SensorDeviceClass, SensorStateFor, SensorConfig, SensorDefinition, ComputedDefinition } from './sensor.js';
export type { BinarySensorDeviceClass, BinarySensorConfig, BinarySensorDefinition } from './binary_sensor.js';
export type { SwitchConfig, SwitchDefinition } from './switch.js';
export type { ColorMode, LightConfig, LightCommand, LightState, LightDefinition } from './light.js';
export type { CoverDeviceClass, CoverConfig, CoverCommand, CoverState, CoverDefinition } from './cover.js';
export type { HVACMode, ClimateConfig, ClimateCommand, ClimateState, ClimateDefinition } from './climate.js';
export type { FanConfig, FanCommand, FanState, FanDefinition } from './fan.js';
export type { LockConfig, LockCommand, LockState, LockDefinition } from './lock.js';
export type { NumberDeviceClass, NumberConfig, NumberDefinition } from './number.js';
export type { SelectConfig, SelectDefinition } from './select.js';
export type { TextConfig, TextDefinition } from './text.js';
export type { ButtonDeviceClass, ButtonConfig, ButtonDefinition } from './button.js';
export type { SirenConfig, SirenCommand, SirenDefinition } from './siren.js';
export type { HumidifierDeviceClass, HumidifierConfig, HumidifierCommand, HumidifierState, HumidifierDefinition } from './humidifier.js';
export type { ValveDeviceClass, ValveConfig, ValveCommand, ValveState, ValveDefinition } from './valve.js';
export type { WaterHeaterMode, WaterHeaterConfig, WaterHeaterCommand, WaterHeaterState, WaterHeaterDefinition } from './water_heater.js';
export type { VacuumConfig, VacuumCommand, VacuumState, VacuumDefinition } from './vacuum.js';
export type { LawnMowerCommand, LawnMowerActivity, LawnMowerDefinition } from './lawn_mower.js';
export type { AlarmControlPanelConfig, AlarmControlPanelCommand, AlarmControlPanelState, AlarmControlPanelDefinition } from './alarm_control_panel.js';
export type { NotifyDefinition } from './notify.js';
export type { UpdateDeviceClass, UpdateConfig, UpdateState, UpdateDefinition } from './update.js';
export type { ImageConfig, ImageDefinition } from './image.js';

// Meta entity types
export type { AutomationContext, AutomationDefinition } from './automation.js';
export type { TaskContext, TaskDefinition } from './task.js';
export type { ModeContext, ModeTransition, ModeDefinition } from './mode.js';
export type { CronDefinition } from './cron.js';

// Device and union types
export type {
  EntityDefinition,
  StatefulEntityDefinition,
  EntityFactory,
  DeviceMemberDefinition,
  DeviceEntityHandle,
  DeviceCommandEntityHandle,
  EntityHandleFor,
  DeviceTaskHandle,
  DeviceModeHandle,
  DeviceCronHandle,
  DeviceAutomationHandle,
  DeviceMemberHandleFor,
  DeviceContext,
  DeviceOptions,
  DeviceDefinition,
} from './device.js';
