import { NextRequest, NextResponse } from "next/server";

import {
  buildPreviewShadowCanary,
  comparePreviewShadowCanary,
  isPreviewShadowCanaryAuthorized,
  readPreviewShadowCanaryRuntime,
  type PreviewShadowCanaryDecisionRow,
  type PreviewShadowCanaryEventRow,
  type PreviewShadowCanaryRootRow,
  type PreviewShadowCanaryTaskRow,
} from "@/lib/autonomous-factory/preview-shadow-canary";
import { captureAutonomousFactoryPlan } from "@/lib/autonomous-factory/control-plane";
import { getSupabaseService } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeErrorCode(error: { code?: string } | null): string {
  return typeof error?.code === "string" ? error.code : "unknown";
}

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

  const supabase = await getSupabaseService();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, failure_code: "AUTONOMOUS_FACTORY_CANARY_SERVICE_UNAVAILABLE" },
      { status: 503 }
    );
  }

  const canary = buildPreviewShadowCanary(runtimeState.commit_sha);
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

  const [rootResult, taskResult, decisionResult, eventResult] = await Promise.all([
    supabase
      .from("hermes_v2_tasks")
      .select("id, parent_task_id, task_type, role, status, stage, metadata")
      .eq("id", capture.root_task_id)
      .maybeSingle(),
    supabase
      .from("hermes_v2_tasks")
      .select(
        "id, parent_task_id, task_type, role, title, status, stage, risk_level, need_human_decision, dependency_task_ids, metadata"
      )
      .eq("parent_task_id", capture.root_task_id),
    supabase
      .from("hermes_v2_human_decisions")
      .select("decision_type, decision_status, external_channel, metadata")
      .eq("task_id", capture.root_task_id),
    supabase
      .from("hermes_v2_task_events")
      .select("event_type, from_status, to_status, payload")
      .eq("task_id", capture.root_task_id),
  ]);

  const readError = rootResult.error ?? taskResult.error ?? decisionResult.error ?? eventResult.error;
  if (readError) {
    console.error("[autonomous-factory-canary] readback failed", {
      code: safeErrorCode(readError),
    });
    return NextResponse.json(
      { ok: false, failure_code: "AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED" },
      { status: 502 }
    );
  }

  const comparison = comparePreviewShadowCanary({
    rootTaskId: capture.root_task_id,
    canary,
    root: (rootResult.data as PreviewShadowCanaryRootRow | null) ?? null,
    tasks: (taskResult.data as PreviewShadowCanaryTaskRow[] | null) ?? [],
    decisions: (decisionResult.data as PreviewShadowCanaryDecisionRow[] | null) ?? [],
    events: (eventResult.data as PreviewShadowCanaryEventRow[] | null) ?? [],
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
