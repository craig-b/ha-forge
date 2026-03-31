export { TransportRouter, UnsupportedEntityTypeError } from './transport.js';
export type { Transport } from './transport.js';

export { MqttTransport } from './mqtt-transport.js';
export type { MqttCredentials, MqttTransportOptions } from './mqtt-transport.js';

export { HAWebSocketClient } from './ws-client.js';
export type { WSClientOptions, HAStateObject, HAStateChangedData, HAEvent, HAResultMessage } from './ws-client.js';

export { HAApiImpl } from './ha-api.js';
export type { HAApi, HAClient, StateChangedEvent, StateChangedCallback, ReactionRule, ValidatorMap, EventHandleTracker } from './ha-api.js';

export { EntityLifecycleManager } from './lifecycle.js';
export type { LifecycleLogger, RawMqttAccess } from './lifecycle.js';

export { loadSingleBundle, installGlobals, setSecrets } from './loader.js';
export type { LoadResult, LoadError, ResolvedDevice } from './loader.js';

export { BuildManager } from './build-manager.js';
export type { BuildDeployOptions, DeployResult } from './build-manager.js';

export { SQLiteLogger } from './sqlite-logger.js';
export type { SQLiteLoggerOptions, LogEntry } from './sqlite-logger.js';

export { HealthEntities } from './health-entities.js';
export type { TscDiagnostic } from './health-entities.js';

export { GitService } from './git-service.js';
export type { CommitInfo } from './git-service.js';

export { DeployManifestManager } from './deploy-manifest.js';
export type { DeployManifest, DeployManifestEntry } from './deploy-manifest.js';

export { migrateToGitVersioning } from './migration.js';
