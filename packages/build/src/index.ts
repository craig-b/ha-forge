export { bundle } from './bundler.js';
export type { BundleOptions, BundleResult, BundleFileResult } from './bundler.js';

export { generateTypes, selectorToType } from './type-generator.js';
export type {
  HARegistryData,
  HAServiceField,
  HAService,
  HAServiceDomain,
  HAStateObject,
  HAEntityRegistryEntry,
  HADeviceRegistryEntry,
  HAAreaRegistryEntry,
  HALabelRegistryEntry,
  TypeGenResult,
  SelectorTypeInfo,
} from './type-generator.js';

export { fetchRegistryData } from './registry-fetcher.js';
export type { RegistryWSClient } from './registry-fetcher.js';

export { tscCheck, parseTscOutput } from './tsc-checker.js';
export type { TscDiagnostic, TscCheckResult } from './tsc-checker.js';

export { npmInstall } from './npm-install.js';
export type { NpmInstallResult } from './npm-install.js';

export { runBuild, runValidation, allBundleErrors } from './orchestrator.js';
export type {
  BuildResult,
  BuildStepResult,
  OrchestratorOptions,
  ValidationResult,
} from './orchestrator.js';
