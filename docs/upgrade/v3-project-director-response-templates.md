# Hermes V3 Project Director Response Templates

Scope: Phase 3A documentation only. These templates are concise Feishu-ready messages for the Project Director.

## 1. Website New Demand Intake

```markdown
收到新需求。我先确认一下范围，确认后再拆任务分发。

需求复述：<用 1 句话复述老板要做的网站/页面/功能>

关键问题：<只问 1 个最关键问题>

建议 A：<方案 A>
建议 B：<方案 B>
推荐：<A/B>。原因：<1 句话>

请回复“选 A / 选 B / 按你建议来 / 开始”。
```

## 2. Unclear Demand Question

```markdown
当前需求还不能直接分发执行。

我理解的是：<当前需求摘要>

关键问题：<只问 1 个阻塞拆任务的问题>

建议：<给出推荐选择或默认安全做法>
```

## 3. Professional Recommendation

```markdown
我的建议：

A：<较小 MVP 或低风险方案>
B：<更完整但风险/耗时更高的方案>

推荐：<A/B>
理由：<1 句话说明为什么>

老板确认后，我再拆成产品、UI、前端、后端、测试、运维任务。
```

## 4. Task Tree Summary After Approval

```markdown
已收到确认，准备按以下任务树推进：

项目：<项目名>
阶段 1：<阶段名> - <出口标准>
阶段 2：<阶段名> - <出口标准>
阶段 3：<阶段名> - <出口标准>

首批可执行子任务：
1. <角色>：<子任务>，产物：<文件/文档>，验收：<标准>
2. <角色>：<子任务>，产物：<文件/文档>，验收：<标准>

风险点：<如无则写“暂无高风险项”>
```

## 5. Confirmation Before Dispatch

```markdown
分发前确认：

已确认范围：<范围摘要>
将分发给：<产品/UI/前端/后端/测试/运维>
不会做：<生产部署/数据库/Worker/API/其他禁止项>

请回复“批准分发”后，我再把最小子任务放入执行队列。
```

## 6. In-Progress Report

```markdown
执行进度更新：

项目：<项目名>
当前阶段：<阶段名>
已完成：<完成项>
进行中：<进行中项>
阻塞：<无/阻塞项>
下一步：<下一步>
```

## 7. Risk Blocker

```markdown
已暂停，原因是发现风险项。

风险等级：<low/medium/high/critical>
风险说明：<1 句话>
影响范围：<文件/服务/数据/用户/部署>

选项：
A：批准继续，按当前方案处理
B：缩小范围，只做安全部分
C：取消该风险项

推荐：<A/B/C>。原因：<1 句话>
默认：未确认前不执行。
```

## 8. Waiting For Boss Decision

```markdown
当前等待老板确认：

问题：<待确认问题>
推荐：<推荐方案>

回复“批准 / 按你建议来 / 选 A / 选 B”后，我再继续拆任务或分发。
```

## 9. Phase Acceptance

```markdown
阶段完成，等待验收：

阶段：<阶段名>
已完成产物：<文件/页面/接口/报告>
验证结果：<lint/build/typecheck/test/人工检查>
遗留风险：<无/风险说明>

请确认：通过 / 需要修改 / 暂停。
```

## 10. Project Launch Acceptance

```markdown
项目上线验收申请：

项目：<项目名>
交付内容：<核心功能摘要>
验证结果：<验证摘要>
预览地址：<如有>
发布风险：<风险与回滚摘要>

请老板确认是否允许进入上线/发布流程。
注意：生产发布需要单独明确批准。
```

## 11. Scope Update After Boss Adds Requirements

```markdown
收到补充需求，我已更新摘要：

当前需求：<更新后的摘要>
新增内容：<新增点>
影响：<对范围/时间/风险的影响>

关键问题：<只问 1 个新的阻塞问题，如不需要则写“无需继续确认”>
建议：<推荐方案>
```

## 12. Cancellation

```markdown
已按老板指示取消该需求。

取消范围：<需求/阶段/任务>
已完成但未继续的产物：<如有>
后续默认不再分发执行，除非老板重新发起。
```

## 13. Template Rules

- 飞书消息要短，先说状态，再说问题和选项。
- 每次最多问一个关键问题。
- 必须给一次明确建议。
- 未确认前不分发任务。
- 风险消息必须写明默认不执行。
