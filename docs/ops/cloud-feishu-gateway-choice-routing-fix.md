# Cloud Feishu Gateway Choice Routing Fix

## 背景

BATCH-22 修复项目总管 A/B 选择后的重复确认问题。本仓库未包含腾讯云服务器上的 `feishu_gateway_canonical.js`，因此云端网关需要单独同步同一套 choice routing 规则。

## 必须同步的规则

- 在云端网关增加老板选择识别：
  - `选 A`
  - `选A`
  - `选择 A`
  - `选 B`
  - `选B`
  - `选择 B`
  - `批准建议`
  - `按 B 做`
  - `先做完整产品规划`
  - `先做首页 MVP`
  - `修改计划：xxx`
- 这些短回复必须在普通 `website_product_request` 路由之前处理。
- `选 B` 或 `先做完整产品规划` 后，应该直接回复完整 MVP 第一阶段规划，或者把完整规划任务写入项目总管 planning。
- `选 A` 或 `先做首页 MVP` 后，应该直接回复首页 MVP 规划。
- 已识别 A/B 选择后，不得再次回复同一套 A/B 确认问题。
- 选择回复不得创建 Worker/Codex 执行任务；只能记录 planning，等待老板回复 `总管 批准执行`。

## 建议同步位置

在 `feishu_gateway_canonical.js` 中，将 choice routing 放在普通网站需求识别之前：

```js
const choice = parseProjectDirectorPlanningChoice(text);
if (choice) {
  // reply planning only, or enqueue project_director planning record
  // do not enqueue Worker/Codex execution job
  return;
}

if (isWebsiteProductRequest(text)) {
  // existing planning-first route
}
```

## 验证命令

在云端网关部署前先做静态检查：

```bash
node --check feishu_gateway_canonical.js
```

建议用测试消息验证：

```text
选 B
选B
选择 B
按 B 做
先做完整产品规划
选 A
先做首页 MVP
修改计划：先只做旅游和学习两个分类
```

验收结果：

- `选 B` 输出完整 MVP 第一阶段规划。
- `选 A` 输出首页 MVP 规划。
- `修改计划：xxx` 只记录计划修改。
- 以上三类都不再次输出 A/B 确认。
- 以上三类都不创建 Worker/Codex 执行任务。
- 普通网站需求仍然先进入 project director planning。

## 回滚方法

1. 保留当前线上 `feishu_gateway_canonical.js` 备份：

```bash
cp feishu_gateway_canonical.js feishu_gateway_canonical.js.bak.batch-22
```

2. 如果上线后出现异常，恢复备份：

```bash
cp feishu_gateway_canonical.js.bak.batch-22 feishu_gateway_canonical.js
```

3. 重启云端网关服务后，重新发送测试消息确认恢复。

