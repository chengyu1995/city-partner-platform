import {
  HERMES_CANONICAL_ORCHESTRATION_ENV,
  HERMES_CANONICAL_SHADOW_ENV,
  resolveHermesCanonicalCutoverConfig,
} from "./cutover-control.ts";

export const HERMES_CANONICAL_SHADOW_ENABLED_DEFAULT = false;
export { HERMES_CANONICAL_SHADOW_ENV };
export const HERMES_CANONICAL_SHADOW_TIMEOUT_ENV = "HERMES_CANONICAL_SHADOW_TIMEOUT_MS";
export const HERMES_CANONICAL_SHADOW_TIMEOUT_DEFAULT_MS = 10_000;
export { HERMES_CANONICAL_ORCHESTRATION_ENV };

export interface HermesShadowRuntimeConfig {
  runtime_environment: "test" | "development" | "production";
  shadow_enabled: boolean;
  canonical_orchestration_enabled: boolean;
  shadow_timeout_ms: number;
  configuration_conflict: boolean;
}

function runtimeEnvironment(
  value: string | undefined,
  nodeTestContext: string | undefined
): HermesShadowRuntimeConfig["runtime_environment"] {
  if (value === "test" || nodeTestContext) return "test";
  if (value === "development") return value;
  return "production";
}

function explicitBoolean(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function shadowTimeout(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return HERMES_CANONICAL_SHADOW_TIMEOUT_DEFAULT_MS;
  return Math.min(60_000, Math.max(25, Math.trunc(parsed)));
}

export function resolveHermesShadowRuntimeConfig(
  env: Record<string, string | undefined> = process.env
): HermesShadowRuntimeConfig {
  const runtime = runtimeEnvironment(env.NODE_ENV, env.NODE_TEST_CONTEXT);
  const explicitShadow = explicitBoolean(env[HERMES_CANONICAL_SHADOW_ENV]);
  const cutover = resolveHermesCanonicalCutoverConfig(env);
  const requestedShadow = explicitShadow ?? runtime === "test";
  return {
    runtime_environment: runtime,
    shadow_enabled: requestedShadow && !cutover.canonical_requested && !cutover.rollback_to_legacy,
    canonical_orchestration_enabled: cutover.canonical_enabled,
    shadow_timeout_ms: shadowTimeout(env[HERMES_CANONICAL_SHADOW_TIMEOUT_ENV]),
    configuration_conflict: requestedShadow && cutover.canonical_requested,
  };
}
