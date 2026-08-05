export const HERMES_CANONICAL_ORCHESTRATION_ENV = "HERMES_CANONICAL_ORCHESTRATION_ENABLED";
export const HERMES_CANONICAL_SHADOW_ENV = "HERMES_CANONICAL_SHADOW_ENABLED";
export const HERMES_CANONICAL_ROLLBACK_ENV = "HERMES_CANONICAL_ROLLBACK_TO_LEGACY";

export interface HermesCanonicalCutoverConfig {
  canonical_requested: boolean;
  canonical_enabled: boolean;
  shadow_requested: boolean;
  shadow_enabled: boolean;
  rollback_to_legacy: boolean;
  legacy_primary: boolean;
  configuration_conflict: boolean;
}

export interface CanonicalWriteGuard {
  recordAuthoritativeWrite(count?: number): void;
  authoritativeWriteCount(): number;
}

export type HermesCanonicalCutoverResult<T> =
  | {
      path: "legacy_primary";
      reason: "canonical_disabled" | "rollback_switch_enabled" | "flag_conflict";
      canonical_result: null;
      canonical_authoritative_writes: 0;
    }
  | {
      path: "legacy_fallback";
      reason: "canonical_prewrite_failure";
      canonical_result: null;
      canonical_authoritative_writes: 0;
      failure_code: "CANONICAL_PREWRITE_FAILURE";
    }
  | {
      path: "canonical_primary";
      reason: "canonical_completed";
      canonical_result: T;
      canonical_authoritative_writes: number;
    };

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function resolveHermesCanonicalCutoverConfig(
  env: Record<string, string | undefined> = process.env
): HermesCanonicalCutoverConfig {
  const canonicalRequested = enabled(env[HERMES_CANONICAL_ORCHESTRATION_ENV]);
  const shadowRequested = enabled(env[HERMES_CANONICAL_SHADOW_ENV]);
  const rollbackToLegacy = enabled(env[HERMES_CANONICAL_ROLLBACK_ENV]);
  const configurationConflict = canonicalRequested && shadowRequested;
  const canonicalEnabled = canonicalRequested && !shadowRequested && !rollbackToLegacy;

  return {
    canonical_requested: canonicalRequested,
    canonical_enabled: canonicalEnabled,
    shadow_requested: shadowRequested,
    shadow_enabled: shadowRequested && !canonicalRequested && !rollbackToLegacy,
    rollback_to_legacy: rollbackToLegacy,
    legacy_primary: !canonicalEnabled,
    configuration_conflict: configurationConflict,
  };
}

function legacyReason(config: HermesCanonicalCutoverConfig): "canonical_disabled" | "rollback_switch_enabled" | "flag_conflict" {
  if (config.rollback_to_legacy) return "rollback_switch_enabled";
  if (config.configuration_conflict) return "flag_conflict";
  return "canonical_disabled";
}

export async function attemptHermesCanonicalCutover<T>(input: {
  env?: Record<string, string | undefined>;
  executeCanonical(guard: CanonicalWriteGuard): Promise<T>;
}): Promise<HermesCanonicalCutoverResult<T>> {
  const config = resolveHermesCanonicalCutoverConfig(input.env ?? process.env);
  if (!config.canonical_enabled) {
    return {
      path: "legacy_primary",
      reason: legacyReason(config),
      canonical_result: null,
      canonical_authoritative_writes: 0,
    };
  }

  let authoritativeWrites = 0;
  const guard: CanonicalWriteGuard = {
    recordAuthoritativeWrite(count = 1) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("CANONICAL_WRITE_COUNT_INVALID");
      }
      authoritativeWrites += count;
    },
    authoritativeWriteCount() {
      return authoritativeWrites;
    },
  };

  try {
    const canonicalResult = await input.executeCanonical(guard);
    return {
      path: "canonical_primary",
      reason: "canonical_completed",
      canonical_result: canonicalResult,
      canonical_authoritative_writes: authoritativeWrites,
    };
  } catch (error) {
    if (authoritativeWrites > 0) {
      throw new Error("CANONICAL_CUTOVER_PARTIAL_WRITE_FAIL_CLOSED", { cause: error });
    }
    return {
      path: "legacy_fallback",
      reason: "canonical_prewrite_failure",
      canonical_result: null,
      canonical_authoritative_writes: 0,
      failure_code: "CANONICAL_PREWRITE_FAILURE",
    };
  }
}
