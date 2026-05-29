# 常见问题排查

## 扫码相关

### Q: 扫码后飞书没有反应

- 确认使用的是飞书 App（非微信、支付宝等）
- 确认飞书版本为最新（旧版本可能不支持 App Registration）
- 检查网络连接，确认能访问 `accounts.feishu.cn`

### Q: 二维码已过期

- 二维码有效期默认 10 分钟
- 重新执行 `--begin` 获取新的二维码

### Q: 提示 "client_secret auth not supported"

- 当前飞书环境不支持动态注册，需手动创建应用：
  1. 访问 [飞书开放平台](https://open.feishu.cn)
  2. 创建企业自建应用
  3. 获取 App ID 和 App Secret
  4. 执行 `--save --app-id "xxx" --app-secret "xxx"` 手动写入配置

### Q: 扫码后提示 "access_denied"

- 用户在飞书确认页面点击了"拒绝"
- 重新执行 `--begin` 获取新二维码，这次在确认页面点击"允许"

## 配置相关

### Q: 保存配置失败

- 检查 `~/.openclaw/` 目录是否存在
- 检查当前用户是否有写入权限
- 使用 `--config` 参数指定自定义路径

### Q: 配置写入后 Bot 不上线

- 需要重启 OpenClaw 使新配置生效
- 检查 `openclaw.json` 中 `channels.feishu.enabled` 是否为 `true`
- 运行 `--status` 确认配置已正确写入

### Q: 国际版（Lark）用户

- 使用 `--domain lark` 参数
- 脚本会自动检测并切换域名（如果扫码用户的租户是 Lark）

## 授权相关

### Q: Bot 创建成功但无法使用飞书功能

- Bot 创建只是第一步，还需要完成用户 OAuth 授权
- 在飞书中给 Bot 发送任意消息，触发配对流程
- 配对后会自动触发 OAuth Device Flow，按提示完成授权

### Q: 权限不足

- 参考 [feishu-permissions.md](./feishu-permissions.md) 开启所需权限
- 部分权限需要企业管理员审批
