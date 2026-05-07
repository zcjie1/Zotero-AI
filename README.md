# Zotero AI 插件

使用 AI 自动解析 Zotero 条目中的 PDF 附件，生成分析笔记。

## 功能

- 📄 **读取 PDF 附件**：自动提取条目下的 PDF 文件
- 🤖 **AI 解析**：智能选择最优方式将 PDF 发送给 AI
  - **优先**：通过 `/v1/files` 上传文件后用文件 ID 引用（Files API）
  - **兜底**：提取文本 + base64 原始文件内嵌到聊天消息中
- 📝 **自动生成笔记**：将 AI 分析结果自动写入条目的子笔记中
- ⚙️ **灵活配置**：支持自定义 API 端点、模型、系统提示词等

## 安装

1. 下载最新的 `.xpi` 文件
2. 在 Zotero 中打开 `工具 → 插件 → 齿轮 → Install Add-on From File`
3. 选择下载的 `.xpi` 文件进行安装

## 开发

```bash
# 安装依赖
npm install

# 启动开发模式（热重载）
npm start

# 构建生产版本
npm run build

# 发布新版本
npm run release
```

## 配置

安装后，在 `编辑 → 设置 → Zotero AI` 中配置：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| API 端点 | OpenAI 兼容 API 基地址（不含 `/v1` 路径，插件自动拼接） | `https://api.openai.com` |
| API 密钥 | 你的 API Key | - |
| 模型名称 | 使用的模型 | `gpt-4o` |
| 系统提示词 | 指导 AI 分析的提示词 | 学术论文分析专家 |
| 温度参数 | 生成多样性 (0-2) | `0.7` |
| 最大 Token | 回复最大长度 | `4096` |

## 使用

1. 在 Zotero 库中选择一个或多个包含 PDF 附件的条目
2. 右键点击 → **🤖 AI 解析**
3. 等待解析完成，AI 分析笔记会自动添加到条目下

## 技术架构

```
zotero-ai/
├── addon/               # XUL/XHTML 和资源文件
│   ├── bootstrap.js     # 插件生命周期入口
│   ├── manifest.json    # 插件清单
│   ├── prefs.js         # 默认偏好设置
│   ├── content/         # UI 资源
│   └── locale/          # 多语言文件
└── src/                 # TypeScript 源码
    ├── index.ts         # 入口
    ├── addon.ts         # 插件主类
    ├── hooks.ts         # 生命周期钩子（菜单注册）
    ├── modules/
    │   └── aiParse.ts   # ⭐ AI 解析核心（三层上传策略）
    └── utils/           # 工具函数
```

### PDF 上传策略

插件按以下优先级尝试发送 PDF 给 AI，任意一层成功即停止：

| 优先级 | 策略 | API | 说明 |
|--------|------|-----|------|
| **Tier 1** | Files API | `POST /v1/files` → `POST /v1/chat/completions` | 先上传文件获取 `file_id`，再在消息中引用 |
| **Tier 2** | Chat 兜底 | `POST /v1/chat/completions` | 提取全文 + 内嵌 base64 到用户消息 |

## 依赖

- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) - Zotero 插件开发工具包
- [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold) - 插件构建工具

## 许可证

AGPL-3.0-or-later
