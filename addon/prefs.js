// Default preferences for Zotero AI plugin
pref("enable", true);
pref("apiEndpoint", "https://api.openai.com");
pref("apiKey", "");
pref("model", "gpt-4o");
pref(
  "systemPrompt",
  "你是一位学术论文分析专家。请仔细阅读以下论文内容，并提供详细的分析，包括：\n1. 研究背景与目的\n2. 研究方法\n3. 主要发现\n4. 结论与贡献\n5. 局限性与未来方向\n\n请用中文回答。",
);
pref("temperature", 0.7);
pref("maxTokens", 4096);
pref("showHeader", false);
pref("pythonPath", "python");
pref("pythonScriptPath", "");
pref("enableVision", true);
