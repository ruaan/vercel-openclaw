/**
 * Structured event logging for the smoke runner.
 *
 * Emits newline-delimited JSON events to stderr. Each line is an
 * independently parseable JSON object with a `type` and `timestamp` field.
 *
 * Event types:
 *   - smoke-start:  emitted once at the beginning of a run
 *   - phase-start:  emitted before each phase executes
 *   - phase-end:    emitted after each phase completes (includes PhaseResult)
 *   - smoke-finish: emitted once at the end of the run (includes summary)
 *   - fatal:        emitted on unrecoverable errors
 */

import type { PhaseResult } from "./remote-phases.js";

// ---------------------------------------------------------------------------
// Event type definitions
// ---------------------------------------------------------------------------

export interface SmokeStartEvent {
  type: "smoke-start";
  timestamp: string;
  baseUrl: string;
  destructive: boolean;
  timeoutMs: number;
  requestTimeoutMs: number;
  authSource: string;
}

export interface PhaseStartEvent {
  type: "phase-start";
  timestamp: string;
  phase: string;
}

export interface PhaseEndEvent {
  type: "phase-end";
  timestamp: string;
  phase: string;
  passed: boolean;
  durationMs: number;
  result: PhaseResult;
}

export interface SmokeFinishEvent {
  type: "smoke-finish";
  timestamp: string;
  passed: boolean;
  phaseCount: number;
  passedCount: number;
  failedCount: number;
  totalMs: number;
}

export interface FatalEvent {
  type: "fatal";
  timestamp: string;
  error: string;
}

export type SmokeEvent =
  | SmokeStartEvent
  | PhaseStartEvent
  | PhaseEndEvent
  | SmokeFinishEvent
  | FatalEvent;

// ---------------------------------------------------------------------------
// Emit function
// ---------------------------------------------------------------------------

/**
 * Write one JSON event as a single line to stderr.
 * Each call produces exactly one `\n`-terminated JSON line.
 */
export function emitEvent(event: SmokeEvent): void {
  process.stderr.write(JSON.stringify(event) + "\n");
}
