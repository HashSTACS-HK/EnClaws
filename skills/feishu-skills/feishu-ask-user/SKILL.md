---
name: feishu-ask-user
description: |
  通过飞书交互式卡片向用户提问并等待回答。支持单选、多选和自由文本输入。工具调用后立即返回，用户答案将以新消息形式回传。
overrides: feishu_ask_user_question
inline: true
---

# feishu-ask-user

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

通过飞书交互式卡片向用户提问，收集选择或文本输入。

## 工具行为

该工具是**非阻塞**的：

1. 调用后立即发送交互式卡片给用户
2. 工具返回 `{ status: 'pending' }`
3. 用户在卡片上填写并提交
4. 用户答案以**新消息**形式回传到当前对话
5. 你在下一轮对话中收到答案

## 使用方式

直接调用 `feishu_ask_user_question` 工具，参数如下：

```json
{
  "questions": [
    {
      "question": "你要问的完整问题",
      "header": "短标签",
      "options": [
        { "label": "选项A", "description": "选项A的说明" },
        { "label": "选项B", "description": "选项B的说明" }
      ],
      "multiSelect": false
    }
  ]
}
```

## 参数说明

| 参数                                | 类型       | 说明                                                          |
| ----------------------------------- | ---------- | ------------------------------------------------------------- |
| `questions`                         | Array(1-6) | 问题列表，最少 1 个，最多 6 个                                |
| `questions[].question`              | String     | 完整的问题描述                                                |
| `questions[].header`                | String     | 短标签（最多 12 字符），显示在卡片左侧                        |
| `questions[].options`               | Array      | 选项列表；**留空 `[]` 表示自由文本输入**                      |
| `questions[].options[].label`       | String     | 选项的显示文本                                                |
| `questions[].options[].description` | String     | 选项的补充说明                                                |
| `questions[].multiSelect`           | Boolean    | `true` = 多选下拉，`false` = 单选下拉（`options` 为空时忽略） |

## 输入类型

### 单选下拉（默认）

提供 `options` 数组 + `multiSelect: false`，用户从下拉列表中选一个。

### 多选下拉

提供 `options` 数组 + `multiSelect: true`，用户可选多个，答案以逗号分隔返回。

### 自由文本输入

将 `options` 设为空数组 `[]`，用户看到文本输入框。

## 关键约束

- **不要轮询或重复调用** — 发送后等待用户回复消息即可
- **不要在提问后立即输出大段文字** — 等用户回答后再继续
- **每次调用最多 6 个问题** — 超过请拆分多次调用
- **header 最多 12 字符** — 用于卡片中简短标识
- **卡片 5 分钟后过期** — 用户需在 5 分钟内提交
- 工具返回 `{ status: 'pending' }` 是正常行为，表示卡片已发送

## 典型场景

### 需要用户确认操作

当执行删除、覆盖等高风险操作前，用此工具确认。

### 需要用户选择

当有多个候选项（如知识库空间、文件夹）需要用户指定时使用。

### 需要用户补充信息

当缺少必要参数且无法自动推断时，用此工具收集。

## 示例

### 单选确认

```json
{
  "questions": [
    {
      "question": "确认要删除「项目文档」吗？此操作不可恢复。",
      "header": "确认删除",
      "options": [
        { "label": "确认删除", "description": "永久删除该文档" },
        { "label": "取消", "description": "保留文档不做改动" }
      ],
      "multiSelect": false
    }
  ]
}
```

### 自由文本输入

```json
{
  "questions": [
    {
      "question": "请输入新文档的标题",
      "header": "文档标题",
      "options": [],
      "multiSelect": false
    }
  ]
}
```

### 混合问题

```json
{
  "questions": [
    {
      "question": "请选择目标知识库空间",
      "header": "知识库",
      "options": [
        { "label": "产品知识库", "description": "产品相关文档" },
        { "label": "技术知识库", "description": "技术方案和架构" }
      ],
      "multiSelect": false
    },
    {
      "question": "请输入文档标题",
      "header": "标题",
      "options": [],
      "multiSelect": false
    }
  ]
}
```
