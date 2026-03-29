/** A single event in a simulated signal. */
export interface SignalEvent {
  /** Timestamp in milliseconds. */
  t: number;
  /** The value at this point in time. */
  value: string | number;
}

/** Time range and resolution for signal generation. */
export interface TimeRange {
  /** Start time in milliseconds. */
  start: number;
  /** End time in milliseconds. */
  end: number;
  /** Step size in milliseconds between generated events. */
  stepMs: number;
}

/** A pure function that generates signal events for a given time range. */
export interface SignalGenerator {
  (range: TimeRange): SignalEvent[];
  /** Total duration in ms, if known (e.g. sum of sequence segment durations). */
  duration?: number;
}

/** A named simulation scenario — a group of signal sources that run together. */
export interface ScenarioDefinition {
  __kind: 'scenario';
  /** Scenario name shown in the UI picker. */
  name: string;
  /** Signal sources, each shadowing a real entity. */
  sources: Array<{ shadows: string; signal: SignalGenerator }>;
}
