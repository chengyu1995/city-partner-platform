import { NextRequest, NextResponse } from "next/server";

import {
  buildPreviewShadowCanary,
  comparePreviewShadowCanary,
  createPreviewShadowCanaryApiKeyFetch,
  isPreviewShadowCanaryAuthorized,
  readPreviewShadowCanaryDatabaseConfig,
  readPreviewShadowCanaryRuntime,
  readPreviewShadowCanarySnapshot,
} from "@/lib/autonomous-factory/preview-shadow-canary";
import { captureAutonomousFactoryPlan } from "@/lib/autonomous-factory/control-plane";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const runtimeState = readPreviewShadowCanaryRuntime();
  if (!runtimeState.ok) {
    return NextResponse.json(
      { ok: false, failure_code: runtimeState.failure_code },
      { status: runtimeState.status }
    );
  }
  if (!isPreviewShadowCanaryAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json(
      { ok: false, failure_code: "AUTONOMOUS_FACTORY_CANARY_UNAUTHORIZED" },
      { status: 401 }
    );
  }

  const databaseConfig = readPreviewShadowCanaryDatabaseConfig();
  if (!databaseConfig) {
    return NextResponse.json(
      { ok: false, failure_code: "AUTONOMOUS_FACTORY_CANARY_SERVICE_UNAVAILABLE" },
      { status: 503 }
    );
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(databaseConfig.url, databaseConfig.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: createPreviewShadowCanaryApiKeyFetch(databaseConfig.secretKey),
    },
  });

  const canary = buildPreviewShadowCanary(runtimeState.commit_sha);
  const preflight = await readPreviewShadowCanarySnapshot({
    client: supabase,
    sourceExternalId: canary.context.eventId,
  });
  if (!preflight.ok) {
    console.error("[autonomous-factory-canary] readback preflight failed", {
      code: preflight.database_code,
    });
    return NextResponse.json(
      { ok: false, failure_code: preflight.error_code },
      { status: 502 }
    );
  }

  const capture = await captureAutonomousFactoryPlan({
    client: supabase,
    draft: canary.draft,
    context: canary.context,
    mode: "shadow",
  });
  if (capture.status !== "captured") {
    return NextResponse.json(
      { ok: false, failure_code: "AUTONOMOUS_FACTORY_CANARY_CAPTURE_FAILED" },
      { status: 502 }
    );
  }

  const readback = await readPreviewShadowCanarySnapshot({
    client: supabase,
    sourceExternalId: canary.context.eventId,
  });
  if (!readback.ok) {
    console.error("[autonomous-factory-canary] readback failed", {
      code: readback.database_code,
    });
    return NextResponse.json(
      { ok: false, failure_code: readback.error_code },
      { status: 502 }
    );
  }

  const comparison = comparePreviewShadowCanary({
    rootTaskId: capture.root_task_id,
    canary,
    root: readback.snapshot.root,
    tasks: readback.snapshot.tasks,
    decisions: readback.snapshot.decisions,
    events: readback.snapshot.events,
  });

  return NextResponse.json(
    {
      ok: comparison.matches,
      canary_id: canary.canary_id,
      mode: "shadow",
      commit_sha: runtimeState.commit_sha,
      root_task_id: capture.root_task_id,
      duplicate: capture.duplicate,
      comparison,
    },
    { status: comparison.matches ? 200 : 409 }
  );
}
