# Cloud Feishu Gateway Boss Console Sync

## 背景

当前仓库内可以修复 `src/app/api/feishu/event/route.ts` 的短命令识别，但腾讯云服务器上的 `feishu_gateway_canonical.js` 不在本项目目录内。本阶段不能假装已经修改云端文件，需要由运维在腾讯云同步同一套短命令优先规则。

## 必须优先识别的短命令

这些命令必须在普通网站需求识别、Codex 入队、Worker 入队之前处理：

- `新需求：状态`
- `新需求：帮助`
- `新需求：查看计划`
- `新需求：系统自检`
- `新需求：Agent 状态`
- `新需求：Agent 看板`
- `总管 状态`
- `总管 帮助`
- `总管 暂停`
- `总管 恢复`
- `总管 批准执行`

等价 ASCII 冒号也要支持，例如 `新需求:状态`、`新需求:帮助`。

## 插入位置

在 `feishu_gateway_canonical.js` 中，短命令判断必须放在这些逻辑之前：

1. 普通 `新需求：...` 网站需求分类。
2. 任何写入 Codex/Worker 执行队列的逻辑。
3. 重复任务检测或任务标准化逻辑。

建议新增函数：

```js
function parseBossConsoleCommand(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  const prefixes = ["新需求", "总管", "项目总管", "老板控制台", "/pd", "/director"];
  let body = normalized;
  for (const prefix of prefixes) {
    if (body === prefix) body = "帮助";
    if (body.startsWith(prefix + "：") || body.startsWith(prefix + ":")) {
      body = body.slice(prefix.length + 1).trim();
      break;
    }
    if (body.startsWith(prefix + " ")) {
      body = body.slice(prefix.length).trim();
      break;
    }
  }
  if (/^(帮助|命令|控制台|菜单|help)$/i.test(body)) return "help";
  if (/^(状态|总览|进度|任务状态|队列|queue|status)$/i.test(body)) return "status";
  if (/^(查看计划|计划|当前计划|任务树|分发计划|plan)$/i.test(body)) return "view_plan";
  if (/^(系统自检|自检|健康检查|health|self[-_ ]?check)$/i.test(body)) return "system_self_check";
  if (/^(Agent 状态|Agent状态|Agent 看板|Agent看板|Agents 状态|Agents状态|Agents 看板|Agents看板|agent status|agent dashboard)$/i.test(body)) return "agent_status";
  if (/^(暂停|暂停Agent|暂停 Agents|停止分发|暂停分发|pause)$/i.test(body)) return "pause_agents";
  if (/^(恢复|继续|恢复Agent|恢复 Agents|继续分发|resume)$/i.test(body)) return "resume_agents";
  if (/^(批准执行|同意执行|开始执行|approve)$/i.test(body)) return "approve_execution";
  return null;
}
```

`approve_execution` 不应直接创建执行任务；它只能委托给项目总管已有审批流程。

## 验证命令

在腾讯云同步后，从飞书逐条发送：

```text
新需求：状态
新需求：帮助
新需求：查看计划
新需求：系统自检
新需求：Agent 状态
新需求：Agent 看板
总管 状态
总管 帮助
总管 暂停
总管 恢复
总管 批准执行
```

验收标准：

- 前 10 条只返回控制台状态或只读信息，不创建 Worker/Codex 任务。
- `总管 批准执行` 在没有计划时提示先规划；有计划时仍检查暂停状态、重复分发和 attempt contract。
- 飞书网关日志中不得出现 `route ignored`。
- 不得把 `状态`、`帮助`、`查看计划` 作为网站开发需求。

## 回滚方法

1. 在腾讯云保留修改前的 `feishu_gateway_canonical.js.bak-YYYYMMDDHHmm`。
2. 如短命令同步后飞书入口异常，恢复备份文件。
3. 重启网关进程。
4. 发送 `新需求：帮助` 验证入口恢复。
