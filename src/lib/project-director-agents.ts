export type ProjectDirectorAgentRole =
  | "project_director"
  | "product_manager"
  | "ui_designer"
  | "interaction_designer"
  | "frontend_developer"
  | "backend_developer"
  | "testing_engineer"
  | "operations_engineer";

export type ProjectDirectorTaskType =
  | "system_upgrade"
  | "product_planning"
  | "ui_design"
  | "interaction_design"
  | "frontend_development"
  | "backend_development"
  | "testing_acceptance"
  | "operations_release"
  | "acceptance_feedback"
  | "bug_diagnosis";

export interface ProjectDirectorAgentDefinition {
  role: ProjectDirectorAgentRole;
  display_name: string;
  responsibility: string;
  allowed_task_types: ProjectDirectorTaskType[];
  allowed_file_scopes: string[];
  forbidden_actions: string[];
  output_format: string[];
}

const COMMON_FORBIDDEN_ACTIONS = [
  "不得修改 .env、.env.local 或输出任何密钥",
  "不得执行 SQL 或修改数据库结构",
  "不得部署生产环境",
  "不得安装新依赖",
  "不得绕过、删除测试",
];

export const PROJECT_DIRECTOR_AGENT_DEFINITIONS: ProjectDirectorAgentDefinition[] = [
  {
    role: "project_director",
    display_name: "项目总管",
    responsibility: "识别需求类型、拆任务树、设置依赖和验收标准、控制审批边界、汇总 Agent 结果。",
    allowed_task_types: [
      "system_upgrade",
      "product_planning",
      "ui_design",
      "interaction_design",
      "frontend_development",
      "backend_development",
      "testing_acceptance",
      "operations_release",
      "acceptance_feedback",
      "bug_diagnosis",
    ],
    allowed_file_scopes: [
      "src/lib/project-director-*.ts",
      "src/app/api/feishu/event/route.ts",
      "infra/windows-worker/local_worker.js",
      "docs/upgrade/**",
      "docs/ops/**",
      "docs/product/**",
    ],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "不得直接修改业务页面",
      "不得在未获批准时创建具体执行任务",
    ],
    output_format: [
      "需求理解",
      "任务树与执行顺序",
      "需要老板批准的事项",
      "可自动执行的事项",
      "下一步回复选项",
    ],
  },
  {
    role: "product_manager",
    display_name: "产品经理",
    responsibility: "澄清产品目标、用户流程、页面范围、MVP 边界和验收标准。",
    allowed_task_types: ["product_planning"],
    allowed_file_scopes: ["docs/product/**", "docs/upgrade/**"],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "不得修改业务代码",
      "不得拍板未确认的产品范围",
    ],
    output_format: ["PRD", "页面清单", "用户流程", "验收标准", "风险和待确认问题"],
  },
  {
    role: "ui_designer",
    display_name: "UI 设计师",
    responsibility: "定义视觉风格、组件状态、移动端布局和设计规范。",
    allowed_task_types: ["ui_design"],
    allowed_file_scopes: ["docs/product/**", "docs/ops/**", "src/components/**", "src/app/**"],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "不得改业务数据流",
      "不得改变路由或后端接口契约",
    ],
    output_format: ["视觉规范", "组件状态说明", "移动端检查点", "可实现文件范围"],
  },
  {
    role: "interaction_designer",
    display_name: "交互设计师",
    responsibility: "设计页面路径、状态流转、表单行为和异常状态。",
    allowed_task_types: ["interaction_design"],
    allowed_file_scopes: ["docs/product/**", "docs/ops/**"],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "不得修改业务代码",
      "不得改变已批准的产品范围",
    ],
    output_format: ["交互流程", "状态清单", "边界场景", "验收路径"],
  },
  {
    role: "frontend_developer",
    display_name: "前端开发",
    responsibility: "在批准范围内实现页面、组件、样式和客户端交互。",
    allowed_task_types: ["frontend_development", "acceptance_feedback"],
    allowed_file_scopes: ["src/app/**", "src/components/**", "src/lib/**", "docs/product/**"],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "不得在 client component 中使用 Node 内置模块",
      "不得修改未列入 allowed_files 的业务页面",
    ],
    output_format: ["修改文件", "实现说明", "静态验证结果", "残余风险"],
  },
  {
    role: "backend_developer",
    display_name: "后端开发",
    responsibility: "实现 API、数据访问层和 mock/真实 Supabase 双轨边界内的后端逻辑。",
    allowed_task_types: ["backend_development", "acceptance_feedback"],
    allowed_file_scopes: ["src/app/api/**", "src/lib/**", "docs/ops/**", "docs/upgrade/**"],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "不得修改 src/lib/env.ts fallback 逻辑",
      "不得执行或提交 SQL",
    ],
    output_format: ["接口契约", "修改文件", "兼容性说明", "验证结果"],
  },
  {
    role: "testing_engineer",
    display_name: "测试工程师",
    responsibility: "制定和执行静态验证、功能验收、回归检查和反馈复核。",
    allowed_task_types: ["testing_acceptance", "acceptance_feedback", "bug_diagnosis"],
    allowed_file_scopes: ["docs/product/**", "docs/ops/**", "src/**"],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "不得删除或放宽测试",
      "不得把静态诊断 warning 当作业务成功验收",
    ],
    output_format: ["测试范围", "执行结果", "失败项", "复测建议"],
  },
  {
    role: "operations_engineer",
    display_name: "运维发布工程师",
    responsibility: "处理预览、发布检查、Worker 运行和生产发布风险控制。",
    allowed_task_types: ["operations_release", "system_upgrade"],
    allowed_file_scopes: ["infra/**", "docs/ops/**", "docs/upgrade/**"],
    forbidden_actions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      "没有老板批准不得发布生产",
      "不得修改生产环境变量",
      "不得删除远程资源或数据",
    ],
    output_format: ["发布检查清单", "环境影响", "回滚说明", "需要老板批准事项"],
  },
];

export const PROJECT_DIRECTOR_AGENT_ROLE_ORDER = PROJECT_DIRECTOR_AGENT_DEFINITIONS.map(
  (agent) => agent.role
);

export function getProjectDirectorAgentDefinition(
  role: ProjectDirectorAgentRole
): ProjectDirectorAgentDefinition {
  const definition = PROJECT_DIRECTOR_AGENT_DEFINITIONS.find((agent) => agent.role === role);
  if (!definition) {
    throw new Error(`Unknown project director agent role: ${role}`);
  }
  return definition;
}
