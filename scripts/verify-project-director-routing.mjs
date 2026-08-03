import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const intakePath = resolve(root, "src/lib/project-director-intake.ts");
const routePath = resolve(root, "src/app/api/feishu/event/route.ts");

function loadIntakeModule() {
  const source = readFileSync(intakePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const commonjsModule = { exports: {} };
  vm.runInNewContext(outputText, {
    module: commonjsModule,
    exports: commonjsModule.exports,
    console,
  });
  return commonjsModule.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoProductPlanningTemplate(label, reply) {
  assert(!reply.includes("首页 MVP"), `${label}: should not mention 首页 MVP`);
  assert(!reply.includes("完整产品规划"), `${label}: should not mention 完整产品规划`);
  assert(!reply.includes("已选择 A"), `${label}: should not choose A`);
  assert(!reply.includes("已选择 B"), `${label}: should not choose B`);
}

const intake = loadIntakeModule();

assert(
  intake.parseProjectDirectorPlanningChoice("BATCH-17 文档整理任务") === null,
  "BATCH-17 must not be parsed as choice B"
);
assert(
  intake.parseProjectDirectorPlanningChoice("BATCH-18 系统修复任务") === null,
  "BATCH-18 must not be parsed as choice B"
);
assert(
  intake.parseProjectDirectorPlanningChoice("BATCH-P2 后续整理") === null,
  "BATCH-P2 must not be parsed as choice B"
);
assert(
  intake.parseProjectDirectorPlanningChoice("总管 批准执行1") === null,
  "总管 批准执行1 must not be parsed as choice A"
);
assert(
  intake.parseProjectDirectorPlanningChoice("完整产品规划") === null,
  "完整产品规划 alone must not be parsed as choice B"
);
assert(
  intake.parseProjectDirectorPlanningChoice("选 B") === "complete_mvp_plan",
  "explicit 选 B should still be parsed"
);
assert(
  intake.parseProjectDirectorPlanningChoice("选择 A") === "homepage_mvp",
  "explicit 选择 A should still be parsed"
);
assert(intake.isDispatchBatchApprovalReply("批准批次"), "批准批次 should be batch approval");
assert(intake.isDispatchBatchApprovalReply("仅批准"), "仅批准 should be batch approval");
assert(intake.isDirectWorkerTaskRequest("请直接创建 Worker 任务：修复项目总管解析"), "direct Worker request should be detected");

assertNoProductPlanningTemplate(
  "document organization",
  intake.buildProjectDirectorReply("新需求：整理 BATCH-17 项目总管文档和验收记录")
);
assertNoProductPlanningTemplate(
  "system repair",
  intake.buildProjectDirectorReply("新需求：修复项目总管确认模板和批准解析逻辑")
);

const routeSource = readFileSync(routePath, "utf8");
const directWorkerIndex = routeSource.indexOf(
  "(isDirectWorkerTaskRequest(text) || isExplicitDirectWorkerCreateCommand(text))"
);
const planningChoiceIndex = routeSource.indexOf("const planningChoice = parseProjectDirectorPlanningChoice(text)");
assert(directWorkerIndex >= 0, "route should contain direct Worker branch");
assert(planningChoiceIndex >= 0, "route should contain planning choice branch");
assert(
  directWorkerIndex < planningChoiceIndex,
  "direct Worker branch must run before A/B planning choice parsing"
);

console.log("project director routing verification passed");
