# Skill Overrides & Inline 机制

> 实现时间：2026-03-27

## 概述

本次实现了两个 SKILL.md frontmatter 扩展，使 tenant skill 能够**零修改插件**地替代插件内置 MCP 工具：

1. **`overrides`** — 声明式移除插件 MCP 工具
2. **`inline`** — 将 skill 内容直接注入系统提示（解决弱模型兼容性）

配合 exec 工具默认配置迁移和凭证自动同步，实现了完整的"插件只做消息管道，tenant skill + 脚本独立实现业务"架构。

---

## 1. `overrides` Frontmatter

### 问题

飞书插件注册了 `feishu_create_doc`、`feishu_pre_auth` 等 MCP 工具。即使 tenant skill 通过同名覆盖替换了 skill 提示词，插件的 MCP 工具仍在工具列表中。弱模型会优先调用这些 MCP 工具而忽略 skill 指令。

### 方案

在 SKILL.md frontmatter 中声明要移除的插件工具名：

```yaml
---
name: feishu-create-doc
overrides: feishu_create_doc, feishu_pre_auth
---
```

框架在构建工具列表时，自动移除 `overrides` 中列出的工具。

### 实现

| 文件                                           | 改动                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `src/agents/skills/frontmatter.ts`             | 新增 `resolveSkillOverrides()`                                         |
| `src/agents/skills/types.ts`                   | `SkillEntry.overrides`, `SkillSnapshot.skillOverrides`                 |
| `src/agents/skills/workspace.ts`               | 构建 entry 时收集 overrides，写入 snapshot                             |
| `src/agents/pi-tools.ts`                       | `createOpenClawCodingTools()` 新增 `skillOverrides` 参数，过滤工具列表 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 从 skillEntries 或 snapshot 收集 overrides 传入                        |
| `src/agents/pi-embedded-runner/compact.ts`     | 同上（compaction 路径）                                                |
| `src/config/sessions/types.ts`                 | `SessionSkillSnapshot.skillOverrides`（session 缓存同步）              |

### 数据流

```
SKILL.md frontmatter
  → resolveSkillOverrides() → SkillEntry.overrides
  → buildWorkspaceSkillSnapshot() → SkillSnapshot.skillOverrides
  → SessionSkillSnapshot.skillOverrides（session 缓存）
  → attempt.ts / compact.ts 收集 skillOverrides
  → createOpenClawCodingTools({ skillOverrides })
  → 工具列表过滤（case-insensitive）
```

### 与 `deny` 配置的关系

| 机制        | 作用范围             |     影响自定义 skill     |
| ----------- | -------------------- | :----------------------: |
| `overrides` | 跟随 skill 生效/失效 | 否（skill 用 exec 工具） |
| `deny`      | 全局/agent 级别      |        否（同上）        |
| 两者共存    | 重复但无害           |            否            |

---

## 2. `inline` Frontmatter

### 问题

Skill 系统的标准流程：

1. 模型看到 `<available_skills>` 列表
2. 模型用 `read` 工具读取 SKILL.md
3. 模型按 SKILL.md 指令执行

**弱模型（如 step-3.5-flash）跳过第 2 步**，不读 SKILL.md，直接去找 MCP 工具。即使 `overrides` 移除了插件工具，模型也只是描述操作而不实际调用 `exec`。

### 方案

在 SKILL.md frontmatter 中声明 `inline: true`，将 skill 内容（去掉 frontmatter）直接嵌入系统提示：

```yaml
---
name: feishu-create-doc
inline: true
---
```

系统提示中会出现：

```xml
<inline_skill name="feishu-create-doc">
# feishu-create-doc

你必须使用 exec 工具执行下方的命令...
</inline_skill>
```

同时系统提示的 Skills 指引增加一条：

> If an `<inline_skill>` block exists for the matching skill, follow its instructions DIRECTLY — do NOT read the SKILL.md file.

### 实现

| 文件                               | 改动                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `src/agents/skills/frontmatter.ts` | 新增 `resolveSkillInline()`                                                         |
| `src/agents/skills/types.ts`       | `SkillEntry.inline`, `SkillEntry.inlineContent`                                     |
| `src/agents/skills/workspace.ts`   | 读取并存储 SKILL.md 内容（`stripFrontmatter`），以 `<inline_skill>` 块附加到 prompt |
| `src/agents/system-prompt.ts`      | 检测 inline 块存在时增加指引                                                        |

### 适用场景

| 模型能力                     |         是否需要 inline          |
| ---------------------------- | :------------------------------: |
| 强模型（Claude, GPT-4）      | 不需要，能正确执行 read → follow |
| 弱模型（step-3.5-flash）     |     需要，否则跳过 SKILL.md      |
| 用户显式调用（`/skill:xxx`） |              不需要              |

---

## 3. Exec 工具默认配置

### 改动

将 exec 工具的安全默认值从代码硬编码迁移到数据库 `sys_tools_config.exec`：

```json
{ "security": "full", "ask": "off", "backgroundMs": 600000 }
```

| 文件                             | 改动                           |
| -------------------------------- | ------------------------------ |
| `src/db/migrations/001_init.sql` | 新建库默认值（已包含存量迁移） |
| `src/db/sqlite/schema-sql.ts`    | SQLite 同步                    |

建议额外配置 `"host": "gateway"` 显式指定本地执行（否则默认 `"sandbox"`，无 sandbox 时 fallback 到本地）。

---

## 4. 凭证自动同步

### 改动

`src/auto-reply/reply/tenant-enrich.ts` 在消息到达时，将飞书 appId/appSecret 从运行时配置自动写入 tenant skill 目录的 `config.json`：

```
DB tenant_channel_apps → runtime config → feishu-auth/config.json
```

脚本只需 `JSON.parse(fs.readFileSync('config.json'))` 即可获取凭证，无需平台特定环境变量。

---

## SKILL.md 示例

```yaml
---
name: feishu-create-doc
description: |
  创建飞书云文档。使用当前用户的个人 OAuth token（非 bot owner 权限），
  支持任意群成员直接创建文档，无需 bot owner 授权。
overrides: feishu_create_doc, feishu_pre_auth
inline: true
---

# feishu-create-doc

**你必须使用 `exec` 工具执行下方的命令。直接调用 `exec` 工具。**

## 调用方式（立即用 exec 工具执行）

cd ~/.enclaws/tenants/{tenantId}/skills/feishu-create-doc && node create-doc.js \
  --open-id  "SENDER_OPEN_ID" \
  --title    "文档标题" \
  --markdown "文档内容"

## 需要授权时

若返回 {"error":"auth_required"}，执行 auth.js --auth-and-poll ...

## 重要规则

- 必须用 exec 工具执行命令
- 不要调用任何 feishu_ 开头的工具
```
