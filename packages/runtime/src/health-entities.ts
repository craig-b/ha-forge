import type { Transport } from './transport.js';

/** Diagnostic from tsc --noEmit (duplicated from build to avoid circular dep) */
export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Manages health entities that report the add-on's status via MQTT discovery.
 *
 * - binary_sensor.ha_forge_build_healthy: on/off based on tsc errors
 * - sensor.ha_forge_type_errors: error count with diagnostic details
 */
export class HealthEntities {
  private transport: Transport;
  private registered = false;

  private buildHealthy = true;
  private typeErrors: TscDiagnostic[] = [];
  private lastChecked: string | null = null;
  private checkTrigger: 'scheduled' | 'registry_change' | 'build' = 'build';

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Register health entities with MQTT discovery via the transport.
   */
  async register(): Promise<void> {
    // Register binary_sensor for build health
    await this.transport.register({
      definition: {
        id: 'ha_forge_build_healthy',
        name: 'HA Forge Build Healthy',
        type: 'binary_sensor',
        icon: 'mdi:check-circle',
        category: 'diagnostic',
        config: {
          device_class: 'problem',
        },
      },

      deviceId: 'ha_forge_system',
    });

    // Register sensor for type error count
    await this.transport.register({
      definition: {
        id: 'ha_forge_type_errors',
        name: 'HA Forge Type Errors',
        type: 'sensor',
        icon: 'mdi:alert-circle',
        category: 'diagnostic',
        config: {
          state_class: 'measurement',
        },
      },

      deviceId: 'ha_forge_system',
    });

    this.registered = true;
    await this.publishStates();
  }

  /**
   * Update health state based on validation results.
   */
  async update(opts: {
    diagnostics: TscDiagnostic[];
    trigger: 'scheduled' | 'registry_change' | 'build';
  }): Promise<void> {
    const errors = opts.diagnostics.filter((d) => d.severity === 'error');
    this.buildHealthy = errors.length === 0;
    this.typeErrors = errors;
    this.lastChecked = new Date().toISOString();
    this.checkTrigger = opts.trigger;

    if (this.registered) {
      await this.publishStates();
    }
  }

  private async publishStates(): Promise<void> {
    // binary_sensor: device_class=problem means "on" = problem detected
    // So invert: buildHealthy=true → state='off' (no problem)
    await this.transport.publishState(
      'ha_forge_build_healthy',
      this.buildHealthy ? 'off' : 'on',
    );

    // sensor: error count + attributes
    await this.transport.publishState(
      'ha_forge_type_errors',
      this.typeErrors.length,
      {
        errors: this.typeErrors.map((e) => ({
          file: e.file,
          line: e.line,
          column: e.column,
          message: e.message,
        })),
        last_checked: this.lastChecked,
        check_trigger: this.checkTrigger,
      },
    );
  }

  getBuildHealthy(): boolean {
    return this.buildHealthy;
  }

  getTypeErrors(): TscDiagnostic[] {
    return this.typeErrors;
  }
}
