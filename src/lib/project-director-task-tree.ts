export type ProjectDirectorRole =
  | "product_manager"
  | "ui_designer"
  | "interaction_designer"
  | "frontend_developer"
  | "backend_developer"
  | "testing_engineer"
  | "operations_engineer";

export interface ProjectDirectorSubtask {
  task_code: string;
  task_title: string;
  role: ProjectDirectorRole;
  input: string[];
  output_files: string[];
  acceptance_criteria: string[];
  dependency_task_codes: string[];
  risk_level: "low" | "medium" | "high" | "critical";
  estimated_minutes: number;
  can_auto_execute: boolean;
}

export interface ProjectDirectorTaskGroup {
  code: string;
  title: string;
  tasks: ProjectDirectorSubtask[];
}

export interface ProjectDirectorStage {
  code: string;
  title: string;
  role: ProjectDirectorRole;
  task_groups: ProjectDirectorTaskGroup[];
}

export interface ProjectDirectorTaskTreeDraft {
  project: {
    title: string;
    goal: string;
    mvp_scope: string[];
    out_of_scope: string[];
    estimated_stages: string[];
  };
  stages: ProjectDirectorStage[];
}

const DEFAULT_MVP_SCOPE = [
  "首页",
  "搭子分类",
  "搭子列表",
  "搭子详情",
  "发布搭子入口",
  "登录状态预留",
  "移动端适配",
];

const DEFAULT_OUT_OF_SCOPE = [
  "即时聊天",
  "支付",
  "复杂推荐算法",
  "复杂后台权限",
  "App、小程序、多城市运营系统",
];

function compactDemandTitle(demand: string): string {
  const normalized = demand.trim().replace(/\s+/g, " ");
  if (!normalized) return "同城搭子网站 MVP";
  if (normalized.length <= 28) return normalized;
  return `${normalized.slice(0, 25)}...`;
}

function task(
  task_code: string,
  task_title: string,
  role: ProjectDirectorRole,
  input: string[],
  output_files: string[],
  acceptance_criteria: string[],
  dependency_task_codes: string[],
  estimated_minutes: number,
  can_auto_execute = true,
  risk_level: ProjectDirectorSubtask["risk_level"] = "low"
): ProjectDirectorSubtask {
  return {
    task_code,
    task_title,
    role,
    input,
    output_files,
    acceptance_criteria,
    dependency_task_codes,
    risk_level,
    estimated_minutes,
    can_auto_execute,
  };
}

export function buildProjectDirectorTaskTreeDraft(
  originalDemand: string,
  bossConfirmation: string
): ProjectDirectorTaskTreeDraft {
  const projectTitle = compactDemandTitle(originalDemand);
  const approvedInput = [
    `原始需求：${originalDemand}`,
    `老板确认：${bossConfirmation}`,
    "阶段 3C 仅生成任务树草案，不分发执行任务。",
  ];

  return {
    project: {
      title: projectTitle,
      goal: "先完成同城搭子类网站的可审核 MVP 方案，明确页面、流程、实现边界和验收标准。",
      mvp_scope: DEFAULT_MVP_SCOPE,
      out_of_scope: DEFAULT_OUT_OF_SCOPE,
      estimated_stages: [
        "产品规划",
        "UI/视觉设计",
        "交互设计",
        "前端开发",
        "后端开发",
        "测试验收",
        "部署上线",
      ],
    },
    stages: [
      {
        code: "PRODUCT",
        title: "产品规划",
        role: "product_manager",
        task_groups: [
          {
            code: "PRODUCT-01",
            title: "PRD 与页面清单",
            tasks: [
              task(
                "PRODUCT-01-01",
                "输出 MVP PRD",
                "product_manager",
                approvedInput,
                ["docs/product/mvp-prd.md"],
                ["明确 MVP 范围和暂不做范围", "覆盖核心用户故事", "不包含未批准的聊天、支付或复杂后台范围"],
                [],
                45
              ),
              task(
                "PRODUCT-01-02",
                "输出页面清单和优先级",
                "product_manager",
                approvedInput,
                ["docs/product/page-list.md"],
                ["列出首页、分类、列表、详情、发布入口和登录预留", "标明首批必须交付页面", "标明依赖关系"],
                ["PRODUCT-01-01"],
                30
              ),
              task(
                "PRODUCT-01-03",
                "输出用户流程",
                "product_manager",
                approvedInput,
                ["docs/product/user-flow.md"],
                ["覆盖首页、分类、列表、详情和发布入口的主流程", "标明登录预留状态", "列出移动端关键路径"],
                ["PRODUCT-01-02"],
                35
              ),
              task(
                "PRODUCT-01-04",
                "输出验收标准",
                "product_manager",
                approvedInput,
                ["docs/product/acceptance-criteria.md"],
                ["覆盖页面、交互、移动端和基础构建检查", "明确首版必须交付和暂不交付内容", "能作为测试验收输入"],
                ["PRODUCT-01-03"],
                30
              ),
            ],
          },
        ],
      },
      {
        code: "UI",
        title: "UI/视觉设计",
        role: "ui_designer",
        task_groups: [
          {
            code: "UI-01",
            title: "首页视觉与设计规范",
            tasks: [
              task(
                "UI-01-01",
                "输出移动端优先视觉规范",
                "ui_designer",
                ["PRODUCT-01-01", "PRODUCT-01-02"],
                ["docs/design/mobile-visual-spec.md"],
                ["符合年轻、轻社交、城市生活风格", "定义卡片、标签、头像、按钮和空状态", "覆盖 375px 与 768px 视口"],
                ["PRODUCT-01-02"],
                45
              ),
            ],
          },
        ],
      },
      {
        code: "IXD",
        title: "交互设计",
        role: "interaction_designer",
        task_groups: [
          {
            code: "IXD-01",
            title: "核心浏览与发布流程",
            tasks: [
              task(
                "IXD-01-01",
                "输出核心交互流程",
                "interaction_designer",
                ["PRODUCT-01-01", "PRODUCT-01-02"],
                ["docs/design/interaction-flow.md"],
                ["覆盖分类到列表、详情、发布入口路径", "说明登录预留状态", "列出加载、空、错误状态"],
                ["PRODUCT-01-02"],
                40
              ),
            ],
          },
        ],
      },
      {
        code: "FRONTEND",
        title: "前端开发",
        role: "frontend_developer",
        task_groups: [
          {
            code: "FRONTEND-01",
            title: "首页与列表实现",
            tasks: [
              task(
                "FRONTEND-01-01",
                "检查现有页面结构",
                "frontend_developer",
                ["PRODUCT-01-02", "UI-01-01", "IXD-01-01"],
                ["docs/implementation/frontend-structure-audit.md"],
                ["列出现有页面和组件可复用点", "不修改业务代码", "标明后续实现文件范围"],
                ["PRODUCT-01-02"],
                30
              ),
              task(
                "FRONTEND-01-02",
                "实现首页 MVP",
                "frontend_developer",
                ["UI-01-01", "IXD-01-01", "FRONTEND-01-01"],
                ["src/app/page.tsx"],
                ["首页展示 MVP 核心入口", "移动端 375px 无横向溢出", "不引入新依赖"],
                ["UI-01-01", "IXD-01-01", "FRONTEND-01-01"],
                90
              ),
            ],
          },
        ],
      },
      {
        code: "BACKEND",
        title: "后端开发",
        role: "backend_developer",
        task_groups: [
          {
            code: "BACKEND-01",
            title: "数据模型和 API 边界",
            tasks: [
              task(
                "BACKEND-01-01",
                "输出数据与 API 边界说明",
                "backend_developer",
                ["PRODUCT-01-01", "PRODUCT-01-02"],
                ["docs/implementation/backend-contract.md"],
                ["说明 mock/真实 Supabase 双轨影响", "不执行 SQL", "不修改数据库结构"],
                ["PRODUCT-01-02"],
                45,
                false,
                "medium"
              ),
            ],
          },
        ],
      },
      {
        code: "TEST",
        title: "测试验收",
        role: "testing_engineer",
        task_groups: [
          {
            code: "TEST-01",
            title: "功能测试和移动端测试",
            tasks: [
              task(
                "TEST-01-01",
                "输出测试验收清单",
                "testing_engineer",
                ["PRODUCT-01-01", "UI-01-01", "IXD-01-01"],
                ["docs/qa/mvp-test-plan.md"],
                ["覆盖首页、分类、列表、详情、发布入口", "包含 375px/768px 移动端检查", "包含 lint/build/typecheck 验证项"],
                ["PRODUCT-01-01", "UI-01-01", "IXD-01-01"],
                35
              ),
            ],
          },
        ],
      },
      {
        code: "RELEASE",
        title: "部署上线",
        role: "operations_engineer",
        task_groups: [
          {
            code: "RELEASE-01",
            title: "预览和上线检查",
            tasks: [
              task(
                "RELEASE-01-01",
                "输出预览发布检查清单",
                "operations_engineer",
                ["TEST-01-01"],
                ["docs/ops/release-checklist.md"],
                ["只准备预览和验收检查", "明确生产发布需要老板单独批准", "不修改 Vercel 环境变量"],
                ["TEST-01-01"],
                30,
                false,
                "medium"
              ),
            ],
          },
        ],
      },
    ],
  };
}

export function buildTaskTreeDraftSummary(draft: ProjectDirectorTaskTreeDraft): string {
  const stageCounts = draft.stages.map((stage) => ({
    title: stage.title,
    count: stage.task_groups.reduce((sum, group) => sum + group.tasks.length, 0),
  }));

  return [
    "【项目总管：任务树草案】",
    `项目：${draft.project.title}`,
    "",
    "我建议的 MVP 范围：",
    ...draft.project.mvp_scope.slice(0, 7).map((item, index) => `${index + 1}. ${item}`),
    "",
    "暂不建议首版做：",
    ...draft.project.out_of_scope.slice(0, 5).map((item, index) => `${index + 1}. ${item}`),
    "",
    "阶段拆解：",
    ...stageCounts.map((stage, index) => `${index + 1}. ${stage.title}：${stage.count} 个子任务`),
    "",
    "首批建议执行任务：",
    "1. 产品经理：输出 PRD",
    "2. 产品经理：输出页面清单",
    "3. UI 设计师：输出设计规范",
    "4. 前端开发：检查现有页面结构",
    "",
    "关键确认：",
    "是否批准这个任务树草案？",
    "请回复：",
    "* 批准任务树",
    "* 修改任务树：{你的要求}",
    "* 暂停",
  ].join("\n");
}

export function buildTaskTreeDraftRecord(
  originalDemand: string,
  bossConfirmation: string,
  draft: ProjectDirectorTaskTreeDraft,
  summary: string
): string {
  return [
    "PROJECT_DIRECTOR_TASK_TREE_DRAFT",
    "state: waiting_task_tree_review",
    `original_demand: ${originalDemand}`,
    `boss_confirmation: ${bossConfirmation}`,
    "summary:",
    summary,
    "json:",
    JSON.stringify(draft, null, 2),
  ].join("\n");
}
