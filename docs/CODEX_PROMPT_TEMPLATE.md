# Codex 单任务提示词模板

> Hermes 每次调用 Codex (GitHub App 集成) 时, 用这个模板填变量后塞进 issue 评论.

## 模板

```text
你是本项目的开发 Agent。

项目：同城搭子网站
技术栈：Next.js + TypeScript + Tailwind CSS + Supabase + Vercel

当前任务：
{{任务名称}}

关联飞书任务：
{{TASK_ID}}

需求说明：
{{需求说明}}

验收标准：
{{验收标准}}

开发要求：
1. 新建分支：feature/{{TASK_ID}}-{{slug}}
2. 不允许直接修改 main。
3. 完成后创建 PR。
4. PR 描述必须包含修改内容、测试方式、风险点。
5. 优先保证移动端体验。
6. 不允许引入大型依赖。
7. 不允许修改生产数据库。
8. 不确定的产品问题不要擅自决定，输出给 Hermes。

完成后输出：
1. PR 链接
2. 修改文件列表
3. 测试结果
4. 风险点
5. 需要老板验收的内容
```

## 变量说明

| 变量 | 来源 | 必填 | 示例 |
|---|---|---|---|
| `{{任务名称}}` | 飞书需求池 (Bitable `需求` 字段) 或人工输入 | ✅ | "给首页加 dark mode 切换按钮" |
| `{{TASK_ID}}` | 飞书 Bitable `ID` 字段 | ✅ | "F-20260613-001" |
| `{{需求说明}}` | 飞书 `需求详情` 字段 或 issue 描述 | ✅ | "用户切到 dark mode 应该..." |
| `{{验收标准}}` | 飞书 `验收` 字段 或 issue 验收段 | ✅ | "1. 切换按钮 2. 持久化 3. 不闪白" |
| `{{slug}}` | 任务名称转 kebab-case | ❌ (自动) | "dark-mode-toggle" |

## Hermes 填模板步骤

1. 读飞书 Bitable (用 `Bitable` App API) 或读 webhook 入队的 JSON
2. 替换 `{{...}}` 变量
3. 调用 `gh issue create --body "..." --title "..." --label "codex-task"`
4. 等 1-5 分钟, 看 Codex 是不是在评论里回复
5. 如果 Codex 跑失败, 把错误摘要回填到飞书 Bitable

## 调用示例 (Python)

```python
import json

TASK = {
    "TASK_ID": "F-20260613-001",
    "title": "给首页加 dark mode 切换按钮",
    "requirement": "用户能切到 dark mode 且持久化, 不闪白",
    "acceptance": "1. 切换按钮存在\n2. localStorage 持久化\n3. 切换不闪白",
}

prompt = f"""你是本项目的开发 Agent。

项目：同城搭子网站
技术栈：Next.js + TypeScript + Tailwind CSS + Supabase + Vercel

当前任务：
{TASK['title']}

关联飞书任务：
{TASK['TASK_ID']}

需求说明：
{TASK['requirement']}

验收标准：
{TASK['acceptance']}

开发要求：
1. 新建分支：feature/{TASK['TASK_ID']}-{slugify(TASK['title'])}
2. 不允许直接修改 main。
3. 完成后创建 PR。
4. PR 描述必须包含修改内容、测试方式、风险点。
5. 优先保证移动端体验。
6. 不允许引入大型依赖。
7. 不允许修改生产数据库。
8. 不确定的产品问题不要擅自决定，输出给 Hermes。

完成后输出：
1. PR 链接
2. 修改文件列表
3. 测试结果
4. 风险点
5. 需要老板验收的内容
"""
```

## slug 工具 (Python)

```python
import re

def slugify(text: str) -> str:
    """中英混合转 kebab-case slug, 全英文走 ASCII, 含中文走 pinyin
    (或者简单降级: 用 hex 短码)"""
    # 简单版: 移除特殊字符, 替换空格为 -
    slug = text.lower().strip()
    # 替换空格为 -
    slug = re.sub(r'\s+', '-', slug)
    # 保留 a-z 0-9 -, 移除其他
    slug = re.sub(r'[^a-z0-9-]', '', slug)
    # 移除连续 -
    slug = re.sub(r'-+', '-', slug)
    # 截断到 50 字符
    return slug[:50].strip('-')

# 示例
print(slugify("给首页加 dark mode 切换按钮"))  # -> "dark-mode"
print(slugify("Fix login bug"))  # -> "fix-login-bug"
```

## 跟 AGENTS.md 13 禁止 + 9 允许的关系

- **本模板**是单任务触发层 (Hermes → Codex 一次)
- **AGENTS.md** 是项目级规则层 (Codex 写代码时必须遵守)
- **两者互补**: 模板告诉 Codex "做什么", AGENTS.md 告诉 Codex "怎么写"

## 完整工作流

```
1. 飞书群提需求
2. 你或助手填飞书 Bitable
3. 飞书自动化触发 webhook → 本地 Flask (8765)
4. Flask 把 task 入队 (queue.jsonl)
5. Hermes cron 每 60s 跑 consume_queue.py
6. consume_queue.py 调 LLM 拆任务 (Python 脚本)
7. 拆出的子任务 1-N 用本模板塞进 Codex 提示词
8. Hermes gh issue create 创 N 个 issue
9. Codex 接到 issue, 自己写代码 + 开 PR
10. Vercel 自动 preview + CI
11. 你 review + merge
12. 反馈回填飞书 Bitable
```

## 已知坑

- **Codex Cloud 任务调度慢** (1-15 分钟), 高峰期更长
- **Codex 任务失败不通知** (需要在 issue 评论里 @codex 重试)
- **Codex Environment 必须配** (Base branch = dev), 不配的话它默认 target main
- **branch 命名** Codex 会**自动**加 `codex/` 前缀 (它的约定), 模板写的 `feature/...` 可能会被 Codex 重命名为 `codex/feature-...`, 不影响

## 反例: 不要这样调用

❌ **没有 TASK_ID**: 让 Codex 接任务但回填不到飞书
❌ **没有验收标准**: Codex 不知道"完成"是什么
❌ **需求说明超过 500 字**: Codex 看不全, 走偏
❌ **一次塞多个任务**: Codex 只能逐个做, 第二个会被遗忘
❌ **"你来设计"**: Codex 不会拍板, 必须给完整设计 (或者让它 @hermes 求助)

## 调试

- 模板生成后, **先** 在本地手动粘到一个 issue 评论里测试
- 跑 1 次看 Codex 是不是按格式回 (如果回了, 模板就稳)
- **之后**才接到飞书 Bitable webhook 自动化
