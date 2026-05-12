# Zotero AI — Agent Instructions

Zotero 7+ 插件，使用 AI 自动解析 PDF 附件并生成结构化笔记。

## Build & Development Commands

```bash
npm install          # 安装依赖
npm start            # 开发模式（热重载，自动在 Zotero 中载入）
npm run build        # 生产构建 + TypeScript 类型检查
npm run lint:check   # 代码检查（Prettier + ESLint）
npm run lint:fix     # 自动格式化 + 修复
npm run release      # 发布 .xpi 到 GitHub Releases
npm test             # 运行插件集成测试
```

- **构建工具**: `zotero-plugin-scaffold` v0.8.2（基于 esbuild）
- **入口**: `src/index.ts` → 打包为 `.scaffold/build/addon/content/scripts/zoteroai.js`
- **目标**: Firefox 115+ (Zotero 6-9 兼容)，ES2022 语法
- **TypeScript 严格模式**: 使用 `zotero-types/entries/sandbox/` 类型定义
- 静态资源 `addon/**/*.*` 原样复制到输出

## Architecture

```
src/
├── index.ts              # 模块入口，创建 Addon 单例，暴露 Zotero.ZoteroAI
├── addon.ts              # 插件状态容器 (data, hooks, api)
├── hooks.ts              # 生命周期钩子 & UI 注册（菜单、偏好设置、状态窗口）
├── modules/
│   ├── aiParse.ts        # AI 解析核心：PDF 提取 → API 调用 → Markdown 渲染 → 创建笔记
│   ├── runtime.ts        # win-x64 托管 Python 运行时、内置脚本和模型管理
│   └── preferenceScript.ts
└── utils/
    ├── ztoolkit.ts        # ZoteroToolkit 初始化（日志、UI、API）
    ├── locale.ts          # Fluent (FTL) 本地化封装
    ├── prefs.ts           # 类型安全的偏好设置读写
    └── window.ts          # 窗口存活检查工具

addon/
├── bootstrap.js           # Firefox XUL 插件生命周期入口（install/startup/shutdown）
├── manifest.json          # 插件清单 (ID: zoteroai@zoteroai.com)
├── prefs.js               # 默认偏好设置值
├── content/
│   ├── preferences.xhtml  # 设置面板 UI（API 端点、密钥、模型、温度等）
│   └── icons/
├── locale/                # 中英文 FTL 翻译文件
│   ├── en-US/
│   └── zh-CN/
├── python/                # Python 图片提取脚本和模型（打包进 XPI）
│   ├── extract_figures.py # DocLayout-YOLO + PyMuPDF 提取 PDF 图表
│   ├── requirements.txt   # pip 依赖清单
│   └── models/            # 内置 DocLayout-YOLO 模型
└── runtime/               # win-x64 最小 Python + pip 启动运行时（打包进 XPI）

python/                    # 项目级 Python 环境（不打包）
└── .venv/                 # conda 虚拟环境（Python 3.10 + PyTorch + 依赖）

reference/
├── AI-paper-reading/      # Python 版 AI 论文阅读（本插件的架构参考）
├── doc-for-zotero-plugin-dev/  # Zotero 插件开发社区文档
└── zotero-plugin-template/     # 插件模板（同源 scaffold）
```

## Key Patterns & Conventions

### 插件生命周期（XUL Overlay 模式）

1. `addon/bootstrap.js` → 注册 chrome manifest → 加载打包后的 `zoteroai.js`
2. `src/index.ts` → 创建 `Addon` 单例，阻止重复初始化
3. `src/hooks.ts`:
   - `onStartup()` → 等待 Zotero 就绪 → 注册偏好设置面板 + 右键菜单
   - `onMainWindowLoad(win)` → 注入 FTL 本地化，重建 ZToolkit
   - `onMainWindowUnload(win)` → 关闭对话框
   - `onShutdown()` → 清理菜单、对话框、命名空间

### AI 解析流水线 (`aiParse.ts`)

```
PDF 附件 → Zotero 全文索引 (att.attachmentText) → 拼接 user message
→ POST /v1/chat/completions (OpenAI 兼容 API, 180s 超时)
→ Markdown → 自定义 HTML 渲染器 → Zotero 子笔记 (note.saveTx())
```

- **并行策略**: `Promise.allSettled()` + 状态回调 → 实时更新 UI 进度窗口
- **LaTeX 保护**: 先用 `\x00` 占位符保护公式，渲染完再恢复
- 不使用外部 Markdown 库，自定义轻量渲染器

### 命名约定

- 插件命名空间: `Zotero.ZoteroAI` (全局单例)
- 偏好设置前缀: `extensions.zotero.zoteroai.*`
- 菜单 ID: `zoteroai-item-parse-menu` / `zoteroai-file-parse-menu`
- 资源 URI: `chrome://zoteroai/content/`

### API 与数据流

- 所有 Zotero API 调用通过 `Zotero.Prefs`、`Zotero.Items`、`Zotero.MenuManager` 等全局对象
- HTTP 请求使用 `XMLHttpRequest`（Firefox 沙箱环境，无 `fetch`）
- 偏好设置为强类型，通过 `PluginPrefsMap` 接口约束
- 错误信息通过 FTL 本地化 (`getString()`)，支持中英文

### 代码风格

- Prettier: 80 字符宽，2 空格缩进，LF 换行
- ESLint: 使用 `@zotero-plugin/eslint-config` 共享规则
- TypeScript 严格沙箱类型（`zotero-types`）
- 禁止 `console.log` 生产环境使用（ZToolkit 管理日志）

## Gotchas & Pitfalls

| 问题                   | 说明                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| **Firefox 沙箱**       | 运行在 Firefox 115 沙箱中，npm 生态库不可用，需避免 Node.js API    |
| **无 fetch API**       | 必须使用 `XMLHttpRequest`，不能用 `fetch()`                        |
| **全文索引依赖**       | PDF 提取依赖 Zotero 7+ 内置索引器，需要 PDF 已被索引               |
| **大 PDF 超时**        | 180s API 超时对于超大 PDF 可能不够，注意 token 限制                |
| **偏好设置前缀**       | 所有 prefs key 自动加 `extensions.zotero.zoteroai.` 前缀           |
| **菜单需手动清理**     | `bootstrap.js` 的 `shutdown()` 中手动 unregister 两个菜单          |
| **重入保护**           | `src/index.ts` 检查 `Zotero.ZoteroAI` 是否已存在防止重复初始化     |
| **LaTeX 公式**         | Markdown 渲染器中 `$` 公式必须先保护后恢复，否则会被 HTML 转义破坏 |
| **API 兼容性**         | 要求 `/v1/chat/completions` 接口兼容 OpenAI 格式（Bearer auth）    |
| **并行解析无并发限制** | 多选条目时全部并行发送，注意 API 速率限制                          |
| **Python 图片提取**    | XPI 内置 `addon/python/extract_figures.py`、DocLayout-YOLO 模型和 win-x64 最小 Python；设置面板“安装/修复运行时”会安装完整依赖到 Zotero 数据目录的 `zoteroai-runtime/win-x64/`；Vision 关闭时不提取图片，直接进行纯文字解析 |

## Reference: Python AI Paper Reading Pipeline

`reference/AI-paper-reading/` 是本插件的架构参考：

- **配置管理**: YAML + `.env` 覆盖，分离 OpenAI / Layout / Runtime 三类配置
- **LLM 客户端**: 指数退避重试（最多 5 次），文本 + 视觉双模式
- **数据模型**: Pydantic 强类型（`BoundingBox`、`ParsedPaper`、`LayoutRegion`）
- **错误类型**: `ConfigurationError`、`LLMServiceError`、`LLMResponseError`

TypeScript 插件简化了 Python 版的版面分析模块，聚焦纯文本 AI 分析。
