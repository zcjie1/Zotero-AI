# Zotero AI

使用 AI 自动解析 Zotero 条目中的 PDF 附件，生成结构化分析笔记。

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%2B-green)](https://www.zotero.org/)

## 功能

- 📄 **PDF 全文提取** — 通过 Zotero 内置全文索引读取 PDF 内容
- 🖼️ **图表提取** — 使用 DocLayout-YOLO 自动检测并裁剪论文中的图表、表格、算法
- ♻️ **图片缓存复用** — 已提取的图片和元数据保存在 Zotero 数据目录，可按需复用或重新提取
- 👁️ **视觉识别 (Vision)** — 可选将提取的图表发送给多模态模型，在笔记正文中引用图片
- 🤖 **AI 解析** — 将全文 + 自定义提示词发送给 OpenAI 兼容 API（`/v1/chat/completions`）
- 📝 **Markdown 笔记** — AI 返回的 Markdown 自动渲染为富文本笔记，支持 LaTeX 数学公式、图片嵌入、引用块
- ⚡ **并行解析** — 多选条目时同时解析，独立窗口实时显示每个条目的进度
- 🌙 **深色模式** — 解析状态窗口自适应 Zotero 主题
- 🗑️ **干净卸载** — 移除插件后不残留菜单项

## 安装

1. 从 [Releases](https://github.com/zcjie1/Zotero-AI/releases) 下载最新 `.xpi` 文件
2. Zotero → `工具` → `插件` → ⚙️ → `Install Add-on From File`
3. 选择 `.xpi` 安装

## 配置

安装后在 `编辑` → `设置` → `Zotero AI` 中配置：

| 设置项       | 说明                                 | 默认值                   |
| ------------ | ------------------------------------ | ------------------------ |
| API 端点     | OpenAI 兼容 API 基地址（不含 `/v1`） | `https://api.openai.com` |
| API 密钥     | 你的 API Key                         | —                        |
| 模型名称     | 模型 ID                              | `gpt-4o`                 |
| 温度参数     | 输出随机性 (0–2)                     | `0.7`                    |
| 最大 Token   | 回复长度上限                         | `4096`                   |
| 系统提示词   | 指导 AI 分析的指令                   | （学术论文分析模板）     |
| 笔记首行标注 | 是否在笔记中显示解析元信息           | 关闭                     |

### 图表提取（可选）

若要启用图表提取，需额外配置 Python 环境：

```bash
# 1. 创建 conda 环境
conda create --prefix ./python/.venv python=3.10 -y
conda install --prefix ./python/.venv pytorch cpuonly -c pytorch -y
conda run --prefix ./python/.venv pip install -r python/requirements.txt

# 2. 下载模型（仅需一次）
conda run --prefix ./python/.venv python python/download_model.py
```

然后在 Zotero 偏好设置中配置：

| 设置项          | 说明                                 | 示例值                                        |
| --------------- | ------------------------------------ | --------------------------------------------- |
| 🐍 Python 路径  | 指向 conda 环境中的 python.exe       | `D:\Code\zotero-ai\python\.venv\python.exe`   |
| 📜 提取脚本路径 | extract_figures.py 的完整路径        | `D:\Code\zotero-ai\python\extract_figures.py` |
| 👁️ 启用视觉识别 | 是否将图片发送给多模态模型分析       | 开启 / 关闭                                   |
| 最大提取数量    | 每篇论文最多提取多少个图表/表格/算法 | `5`                                           |

- **Vision 开启**：图片随全文一起发送给 LLM，模型可在笔记正文中用 `[[FIGURE:Fig1.png]]` 标记图片位置
- **Vision 关闭**：仅提取图片，自动追加到笔记末尾
- 提取结果会保存到 Zotero 数据目录下的 `zoteroai-figures/item_<条目ID>/`，包含 `figures.json` 和裁剪图片。
- 文件名会根据 caption 类型区分为 `Fig1.png`、`Table1.png`、`Alg1.png` 等，减少正文说明和图片错配。

## 使用

1. 在 Zotero 库中选择一个或多个带 PDF 的条目
2. 右键菜单或 `文件` 菜单中选择解析模式：
   - **✨ 智能复用解析**：优先复用已有提取结果；缓存不存在或不完整时自动重新提取
   - **🔄 全新提取解析**：删除当前条目的图片缓存后重新提取
3. 解析状态窗口实时显示进度，完成后笔记自动添加到条目下

## 开发

```bash
npm install          # 安装依赖
npm start            # 开发模式（热重载）
npm run build        # 生产构建
npm run release      # 发布
```

## 架构

```
zotero-ai/
├── addon/
│   ├── bootstrap.js          # 插件生命周期入口
│   ├── manifest.json         # 插件清单
│   ├── prefs.js              # 默认设置
│   ├── content/
│   │   ├── preferences.xhtml # 设置面板 UI
│   │   └── icons/            # 图标
│   └── locale/               # 中英文翻译
├── python/
│   ├── requirements.txt      # Python 依赖
│   ├── download_model.py     # 模型下载脚本（仅需运行一次）
│   └── extract_figures.py    # PDF 图表提取 CLI
└── src/
    ├── index.ts              # 入口
    ├── addon.ts              # 插件主类
    ├── hooks.ts              # 生命周期 & 菜单 & 状态窗口
    ├── modules/
    │   ├── aiParse.ts        # AI 解析核心 + 图表提取调度 + Markdown 渲染
    │   └── preferenceScript.ts
    └── utils/                # 工具函数
```

## 依赖

- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)

## 许可证

[AGPL-3.0-or-later](./LICENSE)
