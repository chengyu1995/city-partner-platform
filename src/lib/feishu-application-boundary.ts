import { resolveHermesCanonicalCutoverConfig } from "./hermes/cutover-control.ts";

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
  const mode = config.canonical_enabled ? "canonical" : config.shadow_enabled ? "shadow" : "legacy";
  return {
    boundary_id: FEISHU_APPLICATION_BOUNDARY_ID,
    mode,
    legacy_primary: config.legacy_primary,
    shadow_enabled: config.shadow_enabled,
    canonical_enabled: config.canonical_enabled,
    configuration_conflict: config.configuration_conflict,
  };
}
