# EnClaws (EC) 产品知识库 — 客服用

> 本文档是 AI 客服 Agent 的知识库来源。客户通过 Web Widget 提问时，AI 基于本文档检索回答。
> 内容来源：EC 官方 README、CLI 文档、产品文档。
> 维护人：Jason (熊剑平)
> 最后更新：2026-04-10

---

## EC 是什么

EnClaws（简称 EC）是一个**企业级 AI 助手容器平台**。它帮助企业创建、调度、隔离、升级和审计大量 AI 助手实例，使其能在团队、流程和业务系统中承担真实工作。

如果说 OpenClaw 是个人助手，EnClaws 就是企业级运行环境——让 AI 从个人工具，进化为企业级运营能力。

**核心定位**：不只是更聪明的助手，而是一套能够运行并治理数字劳动力的系统。

---

## 核心功能

### 1. 一个助手，多个并发任务

EC 支持并发任务执行。比如一个财务助手可以同时处理多个员工的报销申请，而不是让所有人排队等一个聊天窗口。

### 2. 原生多用户隔离

从一开始就为多用户设计：

- 每个用户有独立的执行上下文
- 每个用户有独立的记忆和个性化行为
- 敏感信息不会在人、团队或部门之间泄露

### 3. 层级记忆管理

企业知识不是一个扁平的上下文窗口。EC 支持四层记忆：

- **行业记忆**：公共规则、术语、法规（规划中）
- **公司记忆**：商业模式、政策、文化、产品知识
- **部门记忆**：操作手册、工作流、协作规则（规划中）
- **个人记忆**：个人习惯、偏好、历史上下文

> 注意：当前实际落地的是公司记忆和个人记忆两层。行业和部门层是未来规划。

### 4. 记忆蒸馏与升级

有价值的经验不应该被困在原始日志里。EC 可以捕获经验、提炼为可复用的能力产物、审核脱敏后向上推广——从个人或团队级别提升到部门或公司范围。

### 5. 技能共享与传播

一个助手学到的有用技能不应该被困在一个助手里。EC 支持标准化的技能共享模型，让一个助手验证有效的 Skill 可以被发现、复用、传播给其他助手。

### 6. 审计与状态监控

EC 提供管理视角的可见性：

- 助手状态
- 执行指令
- 风险信号
- Token 消耗与成本可见性
- 可回放的过程、证据和责任链

---

## 安装方式

EC 提供四种安装方式：

### 方式一：npm 安装（全平台）

```bash
npm install -g enclaws
enclaws gateway
```

### 方式二：Windows 一键安装包

从 GitHub Releases 下载 `EnClaws-Setup-x.x.x.exe`，双击安装。无需管理员权限，内置 Node.js 运行时。

### 方式三：一行命令安装（macOS / Linux）

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hashSTACS-Global/EnClaws/main/install.sh | bash
```

### 方式四：从源码构建

前置条件：Node.js >= 22.12.0 + pnpm

```bash
git clone https://github.com/hashSTACS-Global/EnClaws.git
cd EnClaws
pnpm install
pnpm build
pnpm ui:build
npm link
enclaws gateway
```

启动后 Gateway 默认在 `http://localhost:18888` 访问。

---

## 部署模式

### SaaS 版

直接使用 EC 的在线服务，无需搭建服务器。注册后即可使用。

### 私有化部署

EC 支持私有化部署，适合有数据合规要求的企业。具体部署方案请联系我们的团队沟通。

---

## IM 渠道

EC 当前实际落地的 IM 渠道是**飞书**。系统架构支持 41+ 渠道，其他渠道（企业微信、钉钉、Telegram、Discord 等）在 OpenClaw 源码中有支持，但在 EC 产品中尚未正式落地。

### 接入飞书

1. 进入 EC 后台管理界面
2. 找到飞书接入配置
3. 在飞书开放平台创建应用，获取 App ID 和 App Secret
4. 将凭证填入 EC 后台
5. 配置飞书机器人的消息推送
6. 在飞书中测试 Bot 是否正常响应

---

## Skill 插件系统

Skill 是 EC 的插件机制，可以扩展 AI 助手的能力。

### 什么是 Skill

Skill 类似于 AI 助手的"技能包"。安装 Skill 后，助手就能执行对应的操作——比如创建飞书文档、查询数据表、发送消息等。

### 如何安装 Skill

1. 进入 EC 后台的 Skill 管理页面
2. 浏览可用的 Skill 列表
3. 选择需要的 Skill，按照配置引导填写参数
4. 配置完成后 Skill 即在对话中生效

### 可用的 Skill 列表

可以通过以下命令查看：

```bash
enclaws skills list
enclaws skills list --eligible  # 只看满足条件的
enclaws skills info <name>      # 查看具体 Skill 信息
```

---

## 知识库管理

EC 的知识库基于 Markdown 文件 + 向量搜索：

### 上传知识

- 支持上传 **Markdown (.md)** 格式文件
- 可以在后台直接贴文本创建新条目
- 上传后系统自动解析、分块、生成向量索引
- 索引完成后 AI 即可基于文档内容回答问题

### 知识库结构

```
workspace/
  MEMORY.md          # 主知识文件
  memory/             # 知识库目录
    产品介绍.md
    定价方案.md
    常见问题.md
    ...
```

### 相关命令

```bash
enclaws memory status              # 查看知识库状态
enclaws memory index               # 重建索引
enclaws memory search "关键词"      # 搜索知识库
```

### 知识库不准确怎么办

如果 AI 回答不准确，建议：

1. 检查上传的文档格式是否为 Markdown
2. 确保文档内容覆盖了客户可能问到的问题
3. 用清晰的标题和分段组织内容，方便 AI 检索
4. 定期更新文档内容，确保信息是最新的
5. 如果问题持续，请联系我们的技术支持

---

## 团队与权限

### 角色体系

EC 有五级角色：

- **platform-admin**：平台管理员，最高权限
- **owner**：工作空间/租户所有者
- **admin**：工作空间管理员
- **member**：普通成员，读写权限
- **viewer**：只读权限

### 邀请团队成员

1. 进入企业空间的成员管理页面
2. 通过邮箱或链接邀请新成员
3. 为新成员分配合适的角色（admin / member / viewer）
4. 成员接受邀请后即可使用

---

## Agent 管理

EC 支持创建多个 Agent（助手实例），每个 Agent 有独立的工作空间、记忆和配置。

### 创建和管理 Agent

```bash
enclaws agents list                    # 列出所有 Agent
enclaws agents add work --workspace ~/.enclaws/workspace-work  # 添加 Agent
enclaws agents delete work             # 删除 Agent
```

### 路由绑定

可以把特定的 IM 渠道/群组绑定到特定的 Agent：

```bash
enclaws agents bind --agent work --bind feishu:group-123
enclaws agents unbind --agent work --bind feishu:group-123
```

---

## Token 与成本

### Token 计费

EC 的 AI 对话消耗 Token（输入 Token + 输出 Token）。实际消耗取决于：

- 对话长度（消息越长，Token 越多）
- 使用的模型（不同模型价格不同）
- 是否启用了知识库检索（检索会增加上下文 Token）

### 成本追踪

EC 提供 Token 级别的成本追踪功能：

- 按租户维度查看总消耗
- 按成员维度查看个人消耗
- 按模型维度查看不同模型的消耗占比
- 在后台管理界面可以查看详细的成本报表

---

## API 集成

EC Gateway 启动后提供 WebSocket + RPC 接口，默认端口 18888。开发者可以通过 API 将 EC 的 AI 能力嵌入自己的业务系统。

具体 API 文档和集成指南请查阅开发者文档或联系技术支持。

---

## 与竞品的区别

### EC vs Dify

| 维度       | EC (EnClaws)              | Dify                    |
| ---------- | ------------------------- | ----------------------- |
| 定位       | 企业级 AI 助手容器平台    | AI 应用构建平台         |
| 核心场景   | 企业内部多助手管理        | 个人/小团队 AI 应用开发 |
| IM 集成    | 原生深度集成飞书等企业 IM | 需要额外配置            |
| 多租户     | 原生支持                  | 有限支持                |
| Skill 系统 | 企业级技能共享和传播      | 工具/插件机制           |
| 面向用户   | OPC 和超小团队，开箱即用  | 需要一定技术配置        |

---

## 开源协议

EC 采用 **Apache 2.0** 开源协议。代码完全开源，可以自由使用、修改和分发。

GitHub 仓库：https://github.com/hashSTACS-Global/EnClaws

---

## 联系与社区

- **GitHub Issues**：https://github.com/hashSTACS-Global/EnClaws/issues
- **Discord**：https://discord.gg/ExT4MEnK4w
- **飞书群**：扫码加入（见 GitHub README）

如需商务咨询（私有化部署、企业定制等），请通过以上渠道联系我们。

---

## 密码相关

### 忘记密码

EC 提供三种密码重置方式：

1. **CLI 命令**（推荐）：管理员通过 `pnpm admin:reset-password --email user@example.com` 重置
2. **环境变量**：设置 `ENCLAWS_ADMIN_RESET=1` 启动时自动重置管理员密码
3. **邮件自助**（需配置 SMTP）：登录页点击"忘记密码"自助重置

---

## 常见问题

### Q: EC 是免费的吗？

A: EC 采用 Apache 2.0 开源协议，代码完全开源免费。SaaS 版和私有化部署的具体定价请联系我们。

### Q: 数据安全怎么保证？

A: EC 支持私有化部署，数据完全在企业自己的服务器上。SaaS 版的数据安全政策请联系我们了解详情。

### Q: 支持哪些 AI 模型？

A: EC 支持多种 AI 模型提供商，包括 OpenAI、Gemini、Mistral、Voyage 等，也支持本地模型。具体可在后台配置。

### Q: 可以同时使用多个 Agent 吗？

A: 可以。EC 支持创建多个 Agent，每个有独立的工作空间、记忆和配置，通过路由绑定到不同的 IM 渠道或群组。
