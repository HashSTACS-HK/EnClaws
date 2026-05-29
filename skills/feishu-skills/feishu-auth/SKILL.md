---
name: feishu-auth
description: |
  为当前用户完成飞书个人 OAuth 授权。在任何会话过程中，当需要用户授权时，始终执行本技能的授权流程。
overrides: feishu_oauth, feishu_oauth_batch_auth, feishu_pre_auth
inline: true
---

# feishu-auth

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

为用户完成飞书个人 OAuth 授权。

## 运行环境

- **命令**：`node`
- 脚本路径相对于本 SKILL.md 所在目录，执行前需解析为绝对路径

## 授权流程

当需要用户授权时，执行以下命令：

```bash
node "./auth.js" --auth-and-poll --open-id "OPEN_ID" --chat-id "CHAT_ID" --timeout 60
```

- `OPEN_ID`：用户的飞书 open_id（必填）
- `CHAT_ID`：当前会话的 chat_id（可选，有则发到群里，无则发私信）
- `--timeout`：轮询等待秒数（默认 60）

**返回值处理：**

- `{"status":"authorized"}` → 授权成功，**立即继续执行原始任务**，不要输出任何文字
- `{"status":"expired"}` → 授权链接已过期，告知用户重试
- 其他错误 → 停止并告知用户

**重要约束：**

- 执行此命令前后**不要输出任何额外文字**，脚本已自动通过卡片通知用户
- **严禁**使用 `--init` 模式，**严禁**自行向用户展示授权链接 URL
- **严禁**将脚本返回的 JSON 中的 `url` 字段展示给用户
- 只使用 `--auth-and-poll` 模式，它会自动发送授权卡片并等待用户完成

## 其他命令（仅限状态查询和撤销，禁止用于授权）

```bash
node "./auth.js" --status --open-id "OPEN_ID"
node "./auth.js" --revoke --open-id "OPEN_ID"
```
