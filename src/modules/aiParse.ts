import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";

/**
 * AI Parse Module — ZoteroAI
 *
 * Strategy: Extract PDF text via Zotero's built-in full-text index,
 * send as plain text to chat completions.
 * (This API does not support multimodal file upload — file-type
 *  content is routed to a different backend and fails.)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAttText(att: Zotero.Item): Promise<string> {
  try {
    if (att.isPDFAttachment()) return (await att.attachmentText) || "";
  } catch (e) {
    ztoolkit.log("attachmentText error:", e);
  }
  return "";
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

function v1Base(endpoint: string): string {
  let base = endpoint.replace(/\/+$/, "");
  if (!base.endsWith("/v1")) base += "/v1";
  return base;
}

const CHAT_TIMEOUT = 500000; // ~8.3 minutes for AI analysis

// ---------------------------------------------------------------------------
// Core: text extraction + chat
// ---------------------------------------------------------------------------

async function buildTextContent(pdf: Zotero.Item): Promise<string | null> {
  const filename = pdf.getField("filename") || "document.pdf";
  const extracted = await getAttText(pdf);
  if (!extracted || extracted.trim().length === 0) return null;
  return `### ${filename}\n\`\`\`\n${extracted}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Resolve pythonw.exe from configured pythonPath (no console window on Windows)
// ---------------------------------------------------------------------------

function resolvePythonwPath(): string | null {
  const configured = (getPref("pythonPath") as string) || "";
  if (!configured.trim()) return null;

  const trimmed = configured.trim();

  // If user already configured pythonw.exe, use it as-is
  if (trimmed.toLowerCase().endsWith("pythonw.exe")) {
    return trimmed;
  }

  // Derive pythonw.exe from python.exe path
  const pythonw = trimmed.replace(/python\.exe$/i, "pythonw.exe");
  if (pythonw !== trimmed) {
    return pythonw;
  }

  return trimmed;
}

// ---------------------------------------------------------------------------
// Python script path — read from user preference.
// ---------------------------------------------------------------------------

async function getPythonScriptPath(): Promise<string | null> {
  const userPath = (getPref("pythonScriptPath") as string) || "";
  if (userPath.trim()) return userPath.trim();

  ztoolkit.log(
    "[AI Parse] pythonScriptPath not configured, skipping figure extraction. " +
    "Set it in Zotero preferences under \"🖼️ 图片提取\".",
  );
  return null;
}

// ---------------------------------------------------------------------------
// Figure extraction via Python backend
// ---------------------------------------------------------------------------

interface FigureMeta {
  id: string;
  caption: string;
  path: string;
  page: number;
  confidence: number;
}

interface ExtractResult {
  figures: FigureMeta[];
  tempDir: string;
}

async function extractFiguresWithPython(
  pdf: Zotero.Item,
  outputDir: string,
): Promise<ExtractResult | null> {
  const pythonPath = resolvePythonwPath();
  if (!pythonPath) {
    ztoolkit.log("[AI Parse] pythonPath not configured, skipping figure extraction");
    return null;
  }

  const pdfPath = pdf.getFilePath();
  if (!pdfPath) {
    ztoolkit.log("[AI Parse] Cannot get PDF file path");
    return null;
  }

  const scriptPath = await getPythonScriptPath();
  if (!scriptPath) {
    ztoolkit.log("[AI Parse] Cannot locate extract_figures.py, skipping figure extraction");
    return null;
  }

  ztoolkit.log(
    "[AI Parse] Running Python extractor:",
    "\n  cmd:", pythonPath,
    "\n  script:", scriptPath,
    "\n  pdf:", pdfPath,
    "\n  out:", outputDir,
  );

  // Ensure output directory exists before launching Python
  try {
    await IOUtils.makeDirectory(outputDir, { createAncestors: true });
  } catch {
    // Directory may already exist, ignore
  }

  try {
    const result = await Zotero.Utilities.Internal.exec(pythonPath, [
      "-u", scriptPath, pdfPath, outputDir,
      "--max-figures", "5",
    ]);
    if (result instanceof Error) {
      ztoolkit.log("[AI Parse] Python exec returned Error:", String(result));
    } else {
      ztoolkit.log("[AI Parse] Python exec returned:", result);
    }
  } catch (e) {
    ztoolkit.log(
      "[AI Parse] Python exec exception:",
      `type=${typeof e}`,
      `message=${e instanceof Error ? e.message : String(e)}`,
      `stack=${e instanceof Error ? e.stack : "N/A"}`,
    );
    // Don't return null yet — pythonw.exe doesn't produce stdout, so
    // an exception from exec is expected on some Zotero versions.
    // Fall through to check output files.
  }

  // Diagnostic: list output directory with Zotero.File API
  try {
    const dirListing: string[] = [];
    await Zotero.File.iterateDirectory(outputDir, (entry: { name: string; isDir: boolean }) => {
      dirListing.push(`${entry.name}${entry.isDir ? "/" : ""}`);
    });
    ztoolkit.log(
      "[AI Parse] Output dir contents:",
      dirListing.length > 0 ? dirListing.join(", ") : "(empty)",
    );
  } catch (listErr) {
    ztoolkit.log("[AI Parse] Cannot list output dir:", String(listErr));
  }

  // Read result: _status.json (always written) → _error.json → figures.json
  for (const name of ["_status.json", "_error.json", "figures.json"]) {
    const metaPath = PathUtils.join(outputDir, name);
    try {
      // Zotero.File.getContentsAsync reads text files and returns string
      const text = await Zotero.File.getContentsAsync(metaPath) as string;
      ztoolkit.log(`[AI Parse] Read ${name}:`, text.substring(0, 500));
      const json = JSON.parse(text);
      if (name === "_status.json") {
        ztoolkit.log("[AI Parse] Python status:", json.status, json.error || "");
        if (json.status === "error") {
          ztoolkit.log("[AI Parse] Python reported error:", json.error);
          return null;
        }
        continue; // status alone doesn't give us figures, keep looking
      }
      if (name === "_error.json") {
        ztoolkit.log("[AI Parse] Python error:", json.error || "unknown");
        return null;
      }
      const figures: FigureMeta[] = (json.figures || []).map(
        (f: Record<string, unknown>) => ({
          id: String(f.id || ""),
          caption: String(f.caption || ""),
          path: String(f.path || ""),
          page: Number(f.page || 0),
          confidence: Number(f.confidence || 0),
        }),
      );
      ztoolkit.log(`[AI Parse] Extracted ${figures.length} figures`);
      return { figures, tempDir: outputDir };
    } catch { /* try next */ }
  }

  ztoolkit.log("[AI Parse] Python produced no output files");
  return null;
}

async function loadFigureAsBase64(
  outputDir: string,
  figurePath: string,
): Promise<string | null> {
  try {
    const fullPath = PathUtils.join(outputDir, figurePath);
    // IOUtils.read with plain path (not URI) for binary data
    const raw = await IOUtils.read(fullPath);
    const binary = Array.from(raw)
      .map((b) => String.fromCharCode(b))
      .join("");
    const ext = figurePath.split(".").pop()?.toLowerCase() || "png";
    return `data:image/${ext};base64,${btoa(binary)}`;
  } catch (e) {
    ztoolkit.log("[AI Parse] Failed to load figure as base64:", figurePath, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vision chat request
// ---------------------------------------------------------------------------

interface VisionMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

async function sendVisionChatRequest(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string,
  images: Array<{ filename: string; base64: string; caption: string }>,
  maxTokens: number,
  temperature: number,
): Promise<string | null> {
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: userText },
  ];
  for (const img of images) {
    userContent.push({
      type: "image_url",
      image_url: { url: img.base64 },
    });
  }

  // Build vision-aware system prompt with high-priority placeholder instruction.
  // We inject the [[FIGURE:xxx]] rule BEFORE the user's custom prompt so it
  // won't be accidentally overridden by conflicting instructions (e.g. "纯文本回复").
  // Each image is described with its filename and paper caption so the LLM can
  // understand what the figure is about.
  const imageDescriptions = images
    .map((i) => `${i.filename} — ${i.caption || "(无标题)"}`)
    .join("\n");
  const figureInstruction = [
    "<image_placeholder_rules>",
    "引用论文中的图片时，必须使用 [[FIGURE:filename]] 格式标记图片位置，不要使用 Markdown 图片语法。",
    "重要：每张图片只允许在正文中引用一次，不要重复放置同一张图片。",
    "以下图片是从论文中提取的，每张图片附带了论文原标题文本：",
    imageDescriptions,
    "示例：在正文中写 [[FIGURE:Fig3.png]] 来插入 Fig3.png。",
    "</image_placeholder_rules>",
  ].join("\n");
  const visionSystemPrompt = `${figureInstruction}\n\n${systemPrompt}`;

  const messages: VisionMessage[] = [
    { role: "system", content: visionSystemPrompt },
    { role: "user", content: userContent },
  ];

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  ztoolkit.log(
    "[AI Parse] Sending vision chat request, body size:",
    body.length,
    "images:",
    images.length,
  );

  const resp = await Zotero.HTTP.request("POST", endpoint, {
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body,
    responseType: "json",
    timeout: CHAT_TIMEOUT,
  });

  if (resp.status !== 200) {
    ztoolkit.log(
      "[AI Parse] Vision chat failed:",
      resp.status,
      resp.response?.error?.message,
    );
    return null;
  }

  return resp.response?.choices?.[0]?.message?.content || null;
}

async function sendChatRequest(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMsg: string,
  maxTokens: number,
  temperature: number,
): Promise<string | null> {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
    temperature,
    max_tokens: maxTokens,
  });

  ztoolkit.log("[AI Parse] Sending chat request, body size:", body.length);

  const resp = await Zotero.HTTP.request("POST", endpoint, {
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body,
    responseType: "json",
    timeout: CHAT_TIMEOUT,
  });

  if (resp.status !== 200) {
    ztoolkit.log(
      "[AI Parse] Chat failed:",
      resp.status,
      resp.response?.error?.message,
    );
    return null;
  }

  return resp.response?.choices?.[0]?.message?.content || null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function parseItemWithAI(item: Zotero.Item): Promise<void> {
  const endpoint = getPref("apiEndpoint") as string;
  const apiKey = getPref("apiKey") as string;
  const model = getPref("model") as string;
  const systemPrompt = getPref("systemPrompt") as string;
  const temperature = Number(getPref("temperature"));
  const maxTokens = Number(getPref("maxTokens"));
  const enableVision = getPref("enableVision") as boolean;

  if (!apiKey) throw new Error(getString("ai-parse-error-no-api-key"));
  if (!endpoint) throw new Error(getString("ai-parse-error-no-endpoint"));

  // Gather PDFs
  const pdfs: Zotero.Item[] = [];
  for (const id of item.getAttachments()) {
    const att = Zotero.Items.get(id);
    if (att.isPDFAttachment()) pdfs.push(att);
  }
  if (pdfs.length === 0) throw new Error(getString("ai-parse-error-no-pdf"));

  const chatEndpoint = `${v1Base(endpoint)}/chat/completions`;
  const itemTitle = item.getDisplayTitle();

  // Extract text from all PDFs
  const contents: string[] = [];
  for (const pdf of pdfs) {
    const text = await buildTextContent(pdf);
    if (text) contents.push(text);
  }
  if (contents.length === 0) {
    throw new Error(getString("ai-parse-error-no-content"));
  }

  // --- Figure extraction (always runs when pythonPath is configured) ---
  // - enableVision=true  → send images to LLM, use [[FIGURE:xxx]] placeholders
  // - enableVision=false → extract figures but append them at end of note
  let figureBase64Map: Map<string, string> | undefined;
  let visionImages: Array<{ filename: string; base64: string; caption: string }> = [];

  const tempDir = PathUtils.join(
    Zotero.DataDirectory.dir,
    "zoteroai-figures",
    `item_${item.id}`,
  );
  try {
    try {
      const extractResult = await extractFiguresWithPython(
        pdfs[0],
        tempDir,
      );
      if (extractResult && extractResult.figures.length > 0) {
        figureBase64Map = new Map();

        for (const fig of extractResult.figures) {
          const b64 = await loadFigureAsBase64(extractResult.tempDir, fig.path);
          if (!b64) continue;

          figureBase64Map.set(fig.path, b64);

          if (enableVision) {
            visionImages.push({
              filename: fig.path,
              base64: b64,
              caption: fig.caption,
            });
          }
        }
      }
    } catch (e) {
      ztoolkit.log("[AI Parse] Figure extraction failed, continuing text-only:", e);
    }

    // --- Build user message ---
    // When vision is enabled, include figure list + [[FIGURE:xxx]] instruction.
    // When vision is disabled, don't mention figures (they'll be appended later).
    const figureList = enableVision && visionImages.length > 0
      ? `\n提取到的图片及原标题：\n${visionImages.map((i) => `- ${i.filename}: ${i.caption || "(无标题)"}`).join("\n")}`
      : "";

    const userMsg = [
      `请分析以下论文内容。`,
      `条目标题: ${itemTitle}`,
      figureList,
      ``,
      ...contents,
    ].join("\n");

    // --- Send to API (vision or text) ---
    let result: string | null;
    if (enableVision && visionImages.length > 0) {
      result = await sendVisionChatRequest(
        chatEndpoint,
        apiKey,
        model,
        systemPrompt,
        userMsg,
        visionImages,
        maxTokens,
        temperature,
      );
    } else {
      result = await sendChatRequest(
        chatEndpoint,
        apiKey,
        model,
        systemPrompt,
        userMsg,
        maxTokens,
        temperature,
      );
    }

    if (!result) throw new Error(getString("ai-parse-error-no-content"));

    await createChildNote(item, result, model, figureBase64Map);
  } finally {
    // Always clean up temp directory — even on failure, to prevent
    // stale files from interfering with the next parse of the same item.
    try {
      await IOUtils.remove(tempDir, { recursive: true });
    } catch {
      // Best-effort cleanup, directory may not exist
    }
  }
}

// ---------------------------------------------------------------------------
// Note creation
// ---------------------------------------------------------------------------

function markdownToHtml(md: string): string {
  // Pre-process: protect <img> tags BEFORE math protection.
  // Their base64 src can be megabytes long — running inlineFormat regex
  // (.+? backtracking) on them destroys performance and can corrupt HTML.
  const imgTags: string[] = [];
  let processed = md.replace(
    /<img\s[^>]*\/?>/gi,
    (tag) => {
      const idx = imgTags.length;
      imgTags.push(tag);
      return `\x00IMGTAG${idx}\x00`;
    },
  );

  // Pre-process: protect LaTeX display math \[...\] (before $$ to avoid conflict)
  const mathDisplayBracket: string[] = [];

  // Pre-process: protect LaTeX inline math \(...\) (before $$ / $ to avoid conflict)
  const mathInlineBracket: string[] = [];
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_m, formula) => {
    const idx = mathInlineBracket.length;
    mathInlineBracket.push(
      `<span style="background:#f3f0ff;color:#6d28d9;padding:1px 4px;border-radius:3px;font-size:12px;">\\(${formula.trim()}\\)</span>`,
    );
    return `\x00MATHINLINEBR${idx}\x00`;
  });

  // Pre-process: protect LaTeX math blocks $$...$$ before line-based processing
  const mathBlocks: string[] = [];
  processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_m, formula) => {
    const idx = mathBlocks.length;
    mathBlocks.push(
      `<div style="text-align:center;margin:8px 0;padding:8px;background:#f3f0ff;border-radius:4px;font-family:monospace;font-size:13px;">$$${formula.trim()}$$</div>`,
    );
    return `\x00MATHBLOCK${idx}\x00`;
  });

  // Pre-process: protect inline math $...$
  const mathInlines: string[] = [];
  processed = processed.replace(/\$([^$\n]+?)\$/g, (_m, formula) => {
    const idx = mathInlines.length;
    mathInlines.push(
      `<span style="background:#f3f0ff;color:#6d28d9;padding:1px 4px;border-radius:3px;font-size:12px;">$${formula}$</span>`,
    );
    return `\x00MATHINLINE${idx}\x00`;
  });

  const lines = processed.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let inList = false;
  let inBlockquote = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.trim().startsWith("```")) {
      if (inBlockquote) {
        out.push("</blockquote>");
        inBlockquote = false;
      }
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (inCodeBlock) {
        out.push("</code></pre>");
        inCodeBlock = false;
      } else {
        out.push("<pre><code>");
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(escapeHtml(line));
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) {
      if (inBlockquote) {
        out.push("</blockquote>");
        inBlockquote = false;
      }
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push("<hr>");
      continue;
    }

    // Headers
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      if (inBlockquote) {
        out.push("</blockquote>");
        inBlockquote = false;
      }
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const level = hMatch[1].length;
      out.push(`<h${level}>${inlineFormat(hMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (!inBlockquote) {
        out.push("<blockquote>");
        inBlockquote = true;
      }
      out.push(`<p>${inlineFormat(bqMatch[1])}</p>`);
      continue;
    }

    // End blockquote on non-empty, non-quote line
    if (inBlockquote && line.trim() !== "") {
      out.push("</blockquote>");
      inBlockquote = false;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      if (inBlockquote) {
        out.push("</blockquote>");
        inBlockquote = false;
      }
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (inBlockquote) {
        out.push("</blockquote>");
        inBlockquote = false;
      }
      if (inList) {
        out.push("</ul>");
      }
      out.push(`<p>${inlineFormat(line.trim())}</p>`);
      continue;
    }

    // End list if we were in one
    if (inList) {
      out.push("</ul>");
      inList = false;
    }

    // Empty line → paragraph break
    if (line.trim() === "") {
      continue;
    }

    // Regular paragraph
    out.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inBlockquote) out.push("</blockquote>");
  if (inList) out.push("</ul>");
  if (inCodeBlock) out.push("</code></pre>");

  let result = out.join("\n");

  // Restore <img> tags (protected before any processing)
  for (let i = 0; i < imgTags.length; i++) {
    result = result.replace(`\x00IMGTAG${i}\x00`, imgTags[i]);
  }

  // Restore math blocks (order matters: restore in reverse of protection)
  for (let i = 0; i < mathInlineBracket.length; i++) {
    result = result.replace(`\x00MATHINLINEBR${i}\x00`, mathInlineBracket[i]);
  }
  for (let i = 0; i < mathDisplayBracket.length; i++) {
    result = result.replace(`\x00MATHDISPLAY${i}\x00`, mathDisplayBracket[i]);
  }
  for (let i = 0; i < mathBlocks.length; i++) {
    result = result.replace(`\x00MATHBLOCK${i}\x00`, mathBlocks[i]);
  }
  // Restore inline math
  for (let i = 0; i < mathInlines.length; i++) {
    result = result.replace(`\x00MATHINLINE${i}\x00`, mathInlines[i]);
  }

  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineFormat(s: string): string {
  // Bold (must be before italic)
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic
  s = s.replace(/\*(.+?)\*/g, "<i>$1</i>");
  // Inline code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

// ---------------------------------------------------------------------------
// Post-process: replace [[FIGURE:xxx]] placeholders with embedded images
// ---------------------------------------------------------------------------

function postProcessFigures(
  md: string,
  figures: Map<string, string>,
): string {
  return md.replace(
    /\[\[FIGURE:([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, placeholder, altText, imgPath) => {
      const filename = placeholder
        ? placeholder.trim()
        : (imgPath || "").trim();
      if (!filename) return _match;

      let b64 = figures.get(filename);
      if (!b64) {
        const basename = filename.replace(/^.*[/\\]/, "");
        b64 = figures.get(basename);
      }
      if (!b64) {
        for (const [key, val] of figures) {
          if (key.toLowerCase() === filename.toLowerCase()) {
            b64 = val;
            break;
          }
        }
      }
      if (!b64) {
        ztoolkit.log("[AI Parse] Figure not found:", filename);
        return `\n<p style="color:#999;font-style:italic;">[图: ${altText || filename}]</p>\n`;
      }
      const alt = altText || placeholder || filename;
      // Bare <img> — markdownToHtml will wrap it in <p> naturally.
      // Wrapping our own <p> here would cause double-nesting and break rendering.
      return `\n<img src="${b64}" alt="${alt}">\n`;
    },
  );
}

async function createChildNote(
  item: Zotero.Item,
  content: string,
  model: string,
  figureBase64Map?: Map<string, string>,
): Promise<void> {
  const showHeader = getPref("showHeader") as boolean;
  const headerMd = `*AI 解析 (${model}) — ${new Date().toLocaleString()}*\n\n---\n\n`;
  let finalContent = showHeader ? headerMd + content : content;

  let figureInserted = false;
  if (figureBase64Map && figureBase64Map.size > 0) {
    const before = finalContent;
    finalContent = postProcessFigures(finalContent, figureBase64Map);
    figureInserted = finalContent !== before;
  }

  // Convert markdown → HTML BEFORE appending fallback figures.
  // Fallback HTML must NOT go through markdownToHtml, or its <p>/<div>
  // tags will get double-wrapped and break image rendering.
  let html = markdownToHtml(finalContent);

  // Fallback: append all extracted figures at the end of the note.
  if (!figureInserted && figureBase64Map && figureBase64Map.size > 0) {
    const figuresHtml: string[] = [
      '\n\n<div style="border-top:2px solid #e5e7eb;margin-top:24px;padding-top:16px;">',
      '<h2>📷 提取的图片</h2>',
    ];
    for (const [filename, b64] of figureBase64Map) {
      figuresHtml.push(
        `<p style="text-align:center;margin:16px 0;">`,
        `<img src="${b64}" alt="${filename}">`,
        `</p>`,
        `<p style="color:#6b7280;text-align:center;">${filename}</p>`,
      );
    }
    figuresHtml.push("</div>");
    html += figuresHtml.join("\n");
    ztoolkit.log(`[AI Parse] Appended ${figureBase64Map.size} figure(s) at end of note`);
  }

  const note = new Zotero.Item("note");
  note.setNote(html);
  note.parentID = item.id;
  await note.saveTx();
  ztoolkit.log("[AI Parse] Note created");
}

// ---------------------------------------------------------------------------
// Batch (parallel)
// ---------------------------------------------------------------------------

export type ItemStatus = "pending" | "parsing" | "done" | "failed";

export interface ParseTaskResult {
  item: Zotero.Item;
  title: string;
  status: ItemStatus;
  error?: string;
}

export async function parseItemsWithAI(
  items: Zotero.Item[],
  onStatusChange: (results: ParseTaskResult[]) => void,
): Promise<{ success: number; failed: number }> {
  const results: ParseTaskResult[] = items.map((item) => ({
    item,
    title: item.getDisplayTitle(),
    status: "pending" as ItemStatus,
  }));
  onStatusChange([...results]);

  const tasks = items.map(async (item, idx) => {
    results[idx].status = "parsing";
    onStatusChange([...results]);

    try {
      await parseItemWithAI(item);
      results[idx].status = "done";
    } catch (e) {
      results[idx].status = "failed";
      results[idx].error =
        e instanceof Error
          ? e.message
          : e && typeof e === "object"
            ? JSON.stringify(e)
            : String(e);
      ztoolkit.log("Parse error:", item.id, results[idx].error);
    }
    onStatusChange([...results]);
  });

  await Promise.allSettled(tasks);

  const success = results.filter((r) => r.status === "done").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return { success, failed };
}
