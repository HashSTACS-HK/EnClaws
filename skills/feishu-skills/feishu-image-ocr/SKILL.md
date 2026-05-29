---
name: feishu-image-ocr
description: |
  通用图片文字识别（OCR），调用飞书 OCR API，支持中英文混排。
  支持 png/jpg/jpeg/bmp/gif/webp/tiff 等常见图片格式。
  纯 Node.js 实现，零额外依赖，使用应用级 tenant_access_token，无需用户授权。
inline: true
---

# feishu-image-ocr

> **模块兼容**：所有脚本均提供 `.js` 和 `.mjs` 两个版本。优先使用 `.js`，若报 `require is not defined` 错误则改用同名 `.mjs` 文件。

通用图片 OCR 文字识别。调用飞书 OCR API，中英文效果好，纯 Node.js，零额外依赖。
使用应用级 tenant_access_token，**无需用户授权**，只要飞书应用开通了 `ai:image_sentence` 权限即可直接使用。

⚠️ **读完本文件后，不要检查文件是否存在、不要检查环境、不要列目录。脚本文件已就绪，直接用 `exec` 工具执行下方命令。**

## 使用方式

```bash
node ./ocr.js --image "<image_path>"
```

### 可选参数

| 参数     | 说明                             | 默认值         |
| -------- | -------------------------------- | -------------- |
| `--json` | 输出 JSON 格式（含逐行文本列表） | 否，默认纯文本 |

### 输出格式

**纯文本模式**（默认）：逐行输出识别文字。

**JSON 模式**（`--json`）：

```json
{
  "success": true,
  "file_path": "/path/to/image.png",
  "line_count": 12,
  "char_count": 356,
  "text_list": ["第一行", "第二行"],
  "text": "第一行\n第二行"
}
```

## 从其他技能调用

其他技能可直接通过 exec 调用：

```bash
node ../feishu-image-ocr/ocr.js --image "<image_path>" --json
```

例如 `feishu-docx-download` 提取 docx/pptx 中嵌入图片后，可调用本技能识别图片文字。

## 权限不足时

若返回 `{"error":"permission_required"}`，说明飞书应用未开通 OCR 权限。**必须直接将返回 JSON 中的 `reply` 字段内容原样发送给用户**，其中已包含权限管理页面的超链接和操作步骤。

**注意：不要自行组织文案，不要省略链接，直接用 `reply` 字段内容回复用户。**

**⚠️ OCR 权限未开通时，严禁使用视觉能力、其他 API 或任何方式替代识别图片内容，严禁猜测或编造图片内容，严禁将未经 OCR 识别的内容写入记忆或知识库。**

## 权限要求

需要飞书应用管理员在飞书开放平台后台开通 `optical_char_recognition:image` 权限（应用级权限，开通一次所有用户可用，无需用户逐个授权）。

## 禁止事项

- **禁止**检查文件、列目录、检查环境，脚本已就绪
- **禁止**自行编写 OCR 代码或调用其他 OCR API/库
- **禁止**只描述不执行，必须直接调用 `exec`
