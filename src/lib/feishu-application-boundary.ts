import { resolveHermesCanonicalCutoverConfig } from "./hermes/cutover-control.ts";
import { resolveCanonicalCanaryScopeConfig } from "./hermes/canonical-canary-scope.ts";

export const FEISHU_APPLICATION_BOUNDARY_ID = "nextjs_feishu_event_application_v1";

export interface FeishuApplicationFeatureRoute {
  boundary_id: typeof FEISHU_APPLICATION_BOUNDARY_ID;
  mode: "legacy" | "shadow" | "canonical";
  legacy_primary: boolean;
  shadow_enabled: boolean;
  canonical_enabled: boolean;
  configuration_conflict: boolean;
}

export function resolveFeishuApplicationFeatureRoute(
  env: Record<string, string | undefined> = process.env
): FeishuApplicationFeatureRoute {
  const config = resolveHermesCanonicalCutoverConfig(env);
  const canaryScope = resolveCanonicalCanaryScopeConfig(env);
  const canonicalEnabled = config.canonical_enabled && canaryScope.ok;
  const mode = canonicalEnabled ? "canonical" : config.shadow_enabled ? "shadow" : "legacy";
  return {
    boundary_id: FEISHU_APPLICATION_BOUNDARY_ID,
    mode,
    legacy_primary: !canonicalEnabled,
    shadow_enabled: config.shadow_enabled,
    canonical_enabled: canonicalEnabled,
    configuration_conflict: config.configuration_conflict,
  };
}
