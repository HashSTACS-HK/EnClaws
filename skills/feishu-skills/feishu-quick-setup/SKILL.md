---
name: feishu-quick-setup
description: |
  One-click Feishu bot creation. Uses the Feishu App Registration API (Device Flow) to create
  a new Feishu Bot and save credentials to the OpenClaw config file.
  Trigger when the user says "配置飞书", "安装飞书插件", "setup feishu", "创建飞书应用", etc.
  For users who have not yet configured appId/appSecret.
  Note: this skill creates a NEW Feishu app — it is different from feishu-auth (OAuth user authorization).
inline: true
---

# feishu-quick-setup

> **Module compatibility**: Scripts are provided in both `.js` and `.mjs`. Prefer `.mjs`; if you get a module error, fall back to `.js`.

Create a Feishu Bot for the user by executing the commands below step by step. All script output is single-line JSON.

## Runtime

- **Command**: `node`
- Resolve script paths relative to this SKILL.md directory to absolute paths before execution.

## Steps

### Step 1 — Check existing config

```bash
node "{script_dir}/quick-setup.mjs" --status
```

| Field               | Action                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `configured: true`  | Tell the user Feishu is already configured (show `appId`), ask if they want to reconfigure |
| `configured: false` | Proceed to Step 2                                                                          |

### Step 2 — Start registration

```bash
node "{script_dir}/quick-setup.mjs" --begin --domain "feishu"
```

- `--domain`: `feishu` (mainland China, default) or `lark` (international)
- On `error: false` — you get `verificationUrl` and `deviceCode`. Proceed to Step 3.
- On `error: true` — show the error message to the user and stop.

### Step 3 — Show the link

Display the `verificationUrl` from Step 2 to the user **as-is**:

> 请点击以下链接完成飞书授权：
> {verificationUrl}
>
> 点击后在飞书中点击"确认创建"即可。

The correct link format is `https://open.feishu.cn/page/openclaw?user_code=...`. Do not modify or reconstruct the URL.
This flow uses a link, not a QR code.

After showing the link, proceed directly to Step 4 (no need to wait for user reply).

### Step 4 — Poll for completion

```bash
node "{script_dir}/quick-setup.mjs" --poll --wait --timeout 300
```

The script polls internally every 5 seconds until the user completes authorization or the timeout (default 5 min) is reached.

| Result                             | Action                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| `status: "completed"`              | Take `appId` and `appSecret` from the response, proceed to Step 5 |
| `status: "error"`, `expired_token` | Link expired — restart from Step 2                                |
| `status: "error"`, `access_denied` | User denied the request — inform the user                         |
| `status: "timeout"`                | Timed out — suggest the user retry                                |

### Step 5 — Save config

```bash
node "{script_dir}/quick-setup.mjs" --save --app-id "APP_ID" --app-secret "APP_SECRET" --domain "feishu"
```

Replace `APP_ID` and `APP_SECRET` with the values from Step 4.

| Result           | Action                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `success: true`  | Show the `message` field from the response to the user (it contains next-step instructions and a permissions link) |
| `success: false` | Show the failure reason to the user                                                                                |

## Notes

- Always use the commands above; do not call Feishu APIs directly or construct URLs manually.
- This skill creates a new app. For user-level OAuth on an existing app, use `feishu-auth` instead.
- Execute each step — do not skip steps or only describe them.
- Always show the `verificationUrl` exactly as returned by the script.
