import { getRuntimeStatus, installFigureRuntime } from "./runtime";

export { ensureDefaultPrefs, registerPrefsScripts };

const OLD_SYSTEM_PROMPT =
  "你是一位学术论文分析专家。请仔细阅读以下论文内容，并提供详细的分析，包括：\n1. 研究背景与目的\n2. 研究方法\n3. 主要发现\n4. 结论与贡献\n5. 局限性与未来方向\n\n请用中文回答。";

const DEFAULT_SYSTEM_PROMPT = `# 主要任务
目标：提供一篇学术论文的深度解析，要求：  
1. 技术准确性：精确反映论文方法、实验和结论，避免过度简化关键创新点  
2. 逻辑清晰性：用结构化表达帮助读者快速抓住论文核心贡献与技术脉络  
3. 适度的通俗化：对复杂概念提供直观解释（如比喻/类比），但无需回避必要术语  

---

## 输出要求
- Markdown 格式
- 一级标题为 《论文标题》+“论文总结”，若论文标题过长，可缩写
- 二级标题为以下列出的 8 大要点
- 其他内容可以使用三级标题(优先)、加粗文字，禁止使用四级及以上标题
- 允许使用专业术语，但首次出现时需简要说明其作用 
- 无需在表述中增加对原文的引用

---
## 解析内容要求

### 1. 研究背景、动机与挑战

### 2. 当前有哪些解决方案？当前方案遇到哪些挑战？最终的研究问题定义是什么？
- 对当前解决方案的优缺点进行细致介绍
- 若有需要，可引导读者结合原文的图表数据进行阅读
- 切忌使用大量专业术语或本文专有表达，力求通俗易懂但不失专业性

### 3. 本文提出的解决方案概要及其主要创新点
- 根据全文内容总结，力求通俗易懂但不失专业性
- 力求阅读完前三个要点后，可以理解全文的基本逻辑
- 切忌直接照搬原文表述

### 4. 本文提出的解决方案的具体实现设计
- 模块/部件内部的设计细节
- 各个模块之间的协同工作逻辑
- 必要时可使用比喻、举例等手法帮助读者理解
- 必要时可引导读者结合原文的图表数据进行阅读

### 5. 本文提出的解决方案部署方式

### 6. 本文提出的解决方案的性能评估结果

### 7. 本文提出的解决方案存在哪些缺陷

### 8. 本文的代码或数据开源地址URL

---

# 特别提醒
请全力以赴，提供详尽、准确、有洞察力的解析。避免敷衍、笼统或明显未深入理解内容的表述。`;

function registerPrefsScripts(win: Window) {
  ensureDefaultPrefs();
  bindRuntimeInstaller(win);
}

function ensureDefaultPrefs(): void {
  const maxFiguresKey = `${addon.data.config.prefsPrefix}.maxFigures`;
  if (Zotero.Prefs.get(maxFiguresKey, true) === undefined) {
    Zotero.Prefs.set(maxFiguresKey, 5, true);
  }

  const systemPromptKey = `${addon.data.config.prefsPrefix}.systemPrompt`;
  const systemPrompt = Zotero.Prefs.get(systemPromptKey, true);
  if (
    systemPrompt === undefined ||
    systemPrompt === null ||
    systemPrompt === OLD_SYSTEM_PROMPT
  ) {
    Zotero.Prefs.set(systemPromptKey, DEFAULT_SYSTEM_PROMPT, true);
  }
}

function setRuntimeStatus(win: Window, message: string): void {
  const status = win.document.getElementById("zoteroai-runtime-status");
  if (status) {
    status.textContent = message;
  }
}

async function refreshRuntimeStatus(win: Window): Promise<void> {
  try {
    const status = await getRuntimeStatus();
    setRuntimeStatus(win, status.message);
  } catch (e) {
    setRuntimeStatus(
      win,
      `运行时状态检查失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function bindRuntimeInstaller(win: Window): void {
  const button = win.document.getElementById(
    "zotero-prefpane-zoteroai-installRuntime",
  ) as HTMLButtonElement | null;

  if (!button) {
    return;
  }

  void refreshRuntimeStatus(win);

  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true;
      setRuntimeStatus(win, "正在安装图片提取运行时，这可能需要几分钟...");
      try {
        const status = await installFigureRuntime();
        setRuntimeStatus(win, status.message);
      } catch (e) {
        setRuntimeStatus(
          win,
          `运行时安装失败：${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        button.disabled = false;
      }
    })();
  });
}
