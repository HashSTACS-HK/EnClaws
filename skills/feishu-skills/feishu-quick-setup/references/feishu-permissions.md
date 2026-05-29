# 飞书应用权限配置指南

通过 feishu-quick-setup 扫码创建的飞书应用（archetype: PersonalAgent）会自动包含基础权限。
如需使用高级功能，需在飞书开放平台手动开启对应权限。

## 基础权限（自动包含）

扫码创建的 Bot 默认具备以下能力：

- 接收和发送 IM 消息
- 读取用户基本信息

## 按功能所需权限

### 文档操作（feishu-create-doc / feishu-fetch-doc / feishu-update-doc）

| 权限                     | 说明         |
| ------------------------ | ------------ |
| `docx:document`          | 读取文档内容 |
| `docx:document:create`   | 创建文档     |
| `docx:document:readonly` | 只读访问文档 |
| `docs:doc`               | 旧版文档权限 |

### Wiki（feishu-wiki）

| 权限                 | 说明      |
| -------------------- | --------- |
| `wiki:wiki`          | Wiki 读写 |
| `wiki:wiki:readonly` | Wiki 只读 |

### 云盘（feishu-drive）

| 权限                   | 说明         |
| ---------------------- | ------------ |
| `drive:drive`          | 云盘文件读写 |
| `drive:drive:readonly` | 云盘只读     |

### 消息（feishu-im-read / feishu-chat / feishu-im-message）

| 权限                               | 说明                             | 必选场景                           |
| ---------------------------------- | -------------------------------- | ---------------------------------- |
| `im:message.p2p_msg:readonly`      | 接收用户单聊消息                 | 用户私聊机器人                     |
| `im:message.group_at_msg:readonly` | 接收群内 @机器人 消息            | 群里被 @ 响应                      |
| `im:message:send_as_bot`           | 以机器人身份发消息               | 回复用户                           |
| `im:message`                       | 按 message_id 主动读/发消息      | feishu-im-read 历史                |
| `im:message:readonly`              | 只读消息历史                     | 仅读不发时可用此替代               |
| `im:resource`                      | 下载消息里的文件/图片/音视频附件 | **读 zip / pdf / docx 等附件必备** |
| `im:chat:readonly`                 | 读取群聊基本信息                 | 查群成员、群名                     |
| `im:message.group_msg`             | 无 @ 也能读群内所有消息          | 需审批，默认不要                   |

**事件订阅**（权限之外，还要在"事件订阅"页勾选）：

- `im.message.receive_v1` — 接收消息（核心）
- `im.chat.member.bot.added_v1` — 机器人进群（可选）
- `im.chat.member.bot.deleted_v1` — 机器人被移出群（可选）

**⚠️ 关于文件夹附件**：飞书客户端支持在聊天里直接发送本地文件夹（显示为 `<folder key="file_v3_..."/>`），但 open API **未公开** IM 文件夹附件的读取接口（`msg_type` 枚举不含 folder，资源下载 `type` 仅支持 image/file）。即使开通了 `im:resource` 也无法读取文件夹附件内部文件。引导用户改为：① 压缩成 zip 后发送；或 ② 上传云盘分享链接。

### 日历（feishu-calendar）

| 权限                         | 说明         |
| ---------------------------- | ------------ |
| `calendar:calendar`          | 日历事件读写 |
| `calendar:calendar:readonly` | 日历只读     |

### 任务（feishu-task）

| 权限                 | 说明     |
| -------------------- | -------- |
| `task:task`          | 任务读写 |
| `task:task:readonly` | 任务只读 |

### 多维表格（feishu-bitable）

| 权限          | 说明         |
| ------------- | ------------ |
| `bitable:app` | 多维表格读写 |

### 通讯录（feishu-search-user）

| 权限                            | 说明               |
| ------------------------------- | ------------------ |
| `contact:user.base:readonly`    | 读取用户基本信息   |
| `contact:contact.base:readonly` | 读取通讯录基本信息 |

## 如何开启权限

1. 登录 [飞书开放平台](https://open.feishu.cn)
2. 进入应用管理 → 找到扫码创建的应用
3. 左侧菜单 → 权限管理
4. 搜索并开启所需权限
5. 如需管理员审批，联系企业管理员

## 注意事项

- PersonalAgent 类型的应用部分高级权限需要管理员审批
- 权限变更后可能需要用户重新授权（通过 feishu-auth 自动触发）
- 建议按需开启权限，不要一次性开启所有权限
