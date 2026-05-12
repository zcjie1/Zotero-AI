import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { ensureFigureRuntimeAssets, resolveFigurePythonPath } from "./runtime";

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
// Figure extraction via Python backend
// ---------------------------------------------------------------------------

interface FigureMeta {
  id: string;
  kind?: string;
  caption: string;
  path: string;
  page: number;
  confidence: number;
}

interface FigureImage {
  filename: string;
  dataURI: string;
  width?: number;
  height?: number;
}

interface ExtractResult {
  figures: FigureMeta[];
  tempDir: string;
}

export type FigureCacheMode = "reuse" | "refresh";

export interface AIParseOptions {
  figureCacheMode?: FigureCacheMode;
}

function normalizeMaxFigures(value: unknown): number {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed)
    ? Math.max(1, Math.min(50, Math.round(parsed)))
    : 5;
  if (value === undefined || value === null || value === "") {
    Zotero.Prefs.set(
      `${addon.data.config.prefsPrefix}.maxFigures`,
      normalized,
      true,
    );
  }
  return normalized;
}

function parseFigureMetadata(json: unknown, maxFigures: number): FigureMeta[] {
  const payload = json as { figures?: Array<Record<string, unknown>> };
  return (payload.figures || [])
    .map((f: Record<string, unknown>) => ({
      id: String(f.id || ""),
      kind: f.kind ? String(f.kind) : undefined,
      caption: String(f.caption || ""),
      path: String(f.path || ""),
      page: Number(f.page || 0),
      confidence: Number(f.confidence || 0),
    }))
    .filter((f) => f.path)
    .slice(0, maxFigures);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await IOUtils.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCachedFigures(
  outputDir: string,
  maxFigures: number,
): Promise<ExtractResult | null> {
  const metaPath = PathUtils.join(outputDir, "figures.json");
  try {
    const text = (await Zotero.File.getContentsAsync(metaPath)) as string;
    const figures = parseFigureMetadata(JSON.parse(text), maxFigures);

    for (const fig of figures) {
      const imagePath = PathUtils.join(outputDir, fig.path);
      if (!(await pathExists(imagePath))) {
        ztoolkit.log("[AI Parse] Cached figure missing:", imagePath);
        return null;
      }
    }

    ztoolkit.log(
      `[AI Parse] Reusing ${figures.length} cached figure(s) from ${outputDir}`,
    );
    return { figures, tempDir: outputDir };
  } catch {
    return null;
  }
}

async function extractFiguresWithPython(
  pdf: Zotero.Item,
  outputDir: string,
  maxFigures: number,
): Promise<ExtractResult | null> {
  const pythonPath = await resolveFigurePythonPath();
  if (!pythonPath) {
    ztoolkit.log(
      "[AI Parse] Cannot resolve Python runtime, skipping figure extraction",
    );
    return null;
  }

  const pdfPath = pdf.getFilePath();
  if (!pdfPath) {
    ztoolkit.log("[AI Parse] Cannot get PDF file path");
    return null;
  }

  const assets = await ensureFigureRuntimeAssets();
  const userScriptPath = ((getPref("pythonScriptPath") as string) || "").trim();
  const scriptPath = userScriptPath || assets.scriptPath;
  if (!scriptPath) {
    ztoolkit.log(
      "[AI Parse] Cannot locate extract_figures.py, skipping figure extraction",
    );
    return null;
  }

  ztoolkit.log(
    "[AI Parse] Running Python extractor:",
    "\n  cmd:",
    pythonPath,
    "\n  script:",
    scriptPath,
    "\n  pdf:",
    pdfPath,
    "\n  out:",
    outputDir,
  );

  // Ensure output directory exists before launching Python
  try {
    await IOUtils.makeDirectory(outputDir, { createAncestors: true });
  } catch {
    // Directory may already exist, ignore
  }

  try {
    const args = [
      "-u",
      scriptPath,
      pdfPath,
      outputDir,
      "--max-figures",
      String(maxFigures),
    ];
    if (assets.modelPath) {
      args.push("--model-path", assets.modelPath);
    }

    const result = await Zotero.Utilities.Internal.exec(pythonPath, args);
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
    await Zotero.File.iterateDirectory(
      outputDir,
      (entry: { name: string; isDir: boolean }) => {
        dirListing.push(`${entry.name}${entry.isDir ? "/" : ""}`);
      },
    );
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
      const text = (await Zotero.File.getContentsAsync(metaPath)) as string;
      ztoolkit.log(`[AI Parse] Read ${name}:`, text.substring(0, 500));
      const json = JSON.parse(text);
      if (name === "_status.json") {
        ztoolkit.log(
          "[AI Parse] Python status:",
          json.status,
          json.error || "",
        );
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
      const figures = parseFigureMetadata(json, maxFigures);
      ztoolkit.log(`[AI Parse] Extracted ${figures.length} figures`);
      return { figures, tempDir: outputDir };
    } catch {
      /* try next */
    }
  }

  ztoolkit.log("[AI Parse] Python produced no output files");
  return null;
}

function imageMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "png";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function getImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  // PNG: signature + IHDR width/height.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      width: readUint32BE(bytes, 16),
      height: readUint32BE(bytes, 20),
    };
  }

  // JPEG: scan Start Of Frame markers.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return {
          height: readUint16BE(bytes, offset + 5),
          width: readUint16BE(bytes, offset + 7),
        };
      }
      const segmentLength = readUint16BE(bytes, offset + 2);
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
  }

  // GIF: logical screen width/height.
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return {
      width: readUint16LE(bytes, 6),
      height: readUint16LE(bytes, 8),
    };
  }

  return undefined;
}

async function loadFigureAsBase64(
  outputDir: string,
  figurePath: string,
): Promise<FigureImage | null> {
  try {
    const fullPath = PathUtils.join(outputDir, figurePath);
    // IOUtils.read with plain path (not URI) for binary data
    const raw = await IOUtils.read(fullPath);
    const mimeType = imageMimeType(figurePath);
    const dimensions = getImageDimensions(raw);
    return {
      filename: figurePath,
      dataURI: `data:${mimeType};base64,${bytesToBase64(raw)}`,
      width: dimensions?.width,
      height: dimensions?.height,
    };
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
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
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
  const userContent: Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
  }> = [{ type: "text", text: userText }];
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

export async function parseItemWithAI(
  item: Zotero.Item,
  options: AIParseOptions = {},
): Promise<void> {
  const endpoint = getPref("apiEndpoint") as string;
  const apiKey = getPref("apiKey") as string;
  const model = getPref("model") as string;
  const systemPrompt = getPref("systemPrompt") as string;
  const temperature = Number(getPref("temperature"));
  const maxTokens = Number(getPref("maxTokens"));
  const enableVision = getPref("enableVision") as boolean;
  const maxFigures = normalizeMaxFigures(getPref("maxFigures"));
  const figureCacheMode = options.figureCacheMode || "reuse";

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

  // --- Figure extraction (uses managed runtime when available) ---
  // - enableVision=true  → extract images and send them to LLM
  // - enableVision=false → skip extraction entirely and use text-only parsing
  let figureBase64Map: Map<string, FigureImage> | undefined;
  const visionImages: Array<{
    filename: string;
    base64: string;
    caption: string;
  }> = [];

  if (enableVision) {
    const tempDir = PathUtils.join(
      Zotero.DataDirectory.dir,
      "zoteroai-figures",
      `item_${item.id}`,
    );
    try {
      let extractResult: ExtractResult | null = null;

      if (figureCacheMode === "refresh") {
        try {
          await IOUtils.remove(tempDir, { recursive: true });
        } catch {
          // Cache may not exist yet
        }
      } else {
        extractResult = await readCachedFigures(tempDir, maxFigures);
      }

      if (!extractResult) {
        extractResult = await extractFiguresWithPython(
          pdfs[0],
          tempDir,
          maxFigures,
        );
      }

      if (extractResult && extractResult.figures.length > 0) {
        figureBase64Map = new Map();

        for (const fig of extractResult.figures) {
          const image = await loadFigureAsBase64(
            extractResult.tempDir,
            fig.path,
          );
          if (!image) continue;

          figureBase64Map.set(fig.path, image);

          visionImages.push({
            filename: fig.path,
            base64: image.dataURI,
            caption: fig.caption,
          });
        }
      }
    } catch (e) {
      ztoolkit.log(
        "[AI Parse] Figure extraction failed, continuing text-only:",
        e,
      );
    }
  }

  // --- Build user message ---
  // When vision is enabled, include figure list + [[FIGURE:xxx]] instruction.
  // When vision is disabled, don't mention or extract figures.
  const figureList =
    enableVision && visionImages.length > 0
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
}

// ---------------------------------------------------------------------------
// Note creation
// ---------------------------------------------------------------------------

function markdownToHtml(md: string): string {
  // Pre-process: protect <img> tags BEFORE math protection.
  // Their base64 src can be megabytes long — running inlineFormat regex
  // (.+? backtracking) on them destroys performance and can corrupt HTML.
  const imgTags: string[] = [];
  let processed = md.replace(/<img\s[^>]*\/?>/gi, (tag) => {
    const idx = imgTags.length;
    imgTags.push(tag);
    return `\x00IMGTAG${idx}\x00`;
  });

  // Pre-process: protect LaTeX display math \[...\] (before $$ to avoid conflict)
  const mathDisplayBracket: string[] = [];
  processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_m, formula) => {
    const idx = mathDisplayBracket.length;
    mathDisplayBracket.push(renderLatexMath(formula.trim(), true));
    return `\n\x00MATHDISPLAY${idx}\x00\n`;
  });

  // Pre-process: protect LaTeX inline math \(...\) (before $$ / $ to avoid conflict)
  const mathInlineBracket: string[] = [];
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_m, formula) => {
    const idx = mathInlineBracket.length;
    mathInlineBracket.push(renderLatexMath(formula.trim(), false));
    return `\x00MATHINLINEBR${idx}\x00`;
  });

  // Pre-process: protect LaTeX math blocks $$...$$ before line-based processing
  const mathBlocks: string[] = [];
  processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_m, formula) => {
    const idx = mathBlocks.length;
    mathBlocks.push(renderLatexMath(formula.trim(), true));
    return `\n\x00MATHBLOCK${idx}\x00\n`;
  });

  // Pre-process: protect inline math $...$
  const mathInlines: string[] = [];
  processed = processed.replace(/\$([^$\n]+?)\$/g, (_m, formula) => {
    const idx = mathInlines.length;
    mathInlines.push(renderLatexMath(formula.trim(), false));
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

    // Display math placeholders should stay block-level.
    const trimmedLine = line.trim();
    if (
      (trimmedLine.startsWith("\x00MATHBLOCK") ||
        trimmedLine.startsWith("\x00MATHDISPLAY")) &&
      trimmedLine.endsWith("\x00")
    ) {
      out.push(trimmedLine);
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

const greekCommands: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

const symbolCommands: Record<string, string> = {
  cdot: "⋅",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  sim: "∼",
  propto: "∝",
  equiv: "≡",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  mapsto: "↦",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "∙",
  degree: "°",
};

const functionCommands = new Set([
  "arg",
  "cos",
  "cosh",
  "cot",
  "coth",
  "csc",
  "deg",
  "det",
  "dim",
  "exp",
  "gcd",
  "hom",
  "inf",
  "ker",
  "lg",
  "lim",
  "liminf",
  "limsup",
  "ln",
  "log",
  "max",
  "min",
  "Pr",
  "sec",
  "sin",
  "sinh",
  "sup",
  "tan",
  "tanh",
]);

const operatorCommands: Record<string, string> = {
  sum: "∑",
  prod: "∏",
  coprod: "∐",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
};

const delimiterCommands: Record<string, string> = {
  lbrace: "{",
  rbrace: "}",
  langle: "⟨",
  rangle: "⟩",
  lvert: "|",
  rvert: "|",
  lVert: "‖",
  rVert: "‖",
};

function renderLatexMath(formula: string, display: boolean): string {
  if (!formula) return "";

  try {
    const parser = new LatexMathParser(formula, display);
    const body = parser.parse();
    const math = `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display ? "block" : "inline"}" title="${escapeAttr(formula)}"><mrow>${body}</mrow></math>`;
    if (!display) return math;
    return `<div style="text-align:center;margin:10px 0;overflow-x:auto;">${math}</div>`;
  } catch (e) {
    ztoolkit.log("[AI Parse] Failed to render LaTeX math:", formula, e);
    const fallback = escapeHtml(formula);
    if (!display) return `<code>${fallback}</code>`;
    return `<pre><code>${fallback}</code></pre>`;
  }
}

function mml(
  tag: string,
  content: string,
  attrs: Record<string, string | undefined> = {},
): string {
  const attrText = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => ` ${key}="${escapeAttr(String(value))}"`)
    .join("");
  return `<${tag}${attrText}>${content}</${tag}>`;
}

function mmlToken(
  tag: string,
  value: string,
  attrs: Record<string, string | undefined> = {},
): string {
  return mml(tag, escapeHtml(value), attrs);
}

function splitLatexTopLevel(input: string, separator: "&" | "\\\\"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      if (separator === "\\\\" && input[i + 1] === "\\" && depth === 0) {
        parts.push(input.slice(start, i));
        i++;
        start = i + 1;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (separator === "&" && ch === "&" && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(input.slice(start));
  return parts;
}

function renderLatexEnvironment(
  env: string,
  content: string,
  display: boolean,
): string {
  const normalized = env.replace(/\*$/, "");
  if (["equation", "gather", "split"].includes(normalized)) {
    return new LatexMathParser(content, display).parse();
  }

  if (
    [
      "matrix",
      "pmatrix",
      "bmatrix",
      "Bmatrix",
      "vmatrix",
      "Vmatrix",
      "array",
      "aligned",
      "align",
      "cases",
    ].includes(normalized)
  ) {
    const rows = splitLatexTopLevel(content, "\\\\")
      .map((row) => row.trim())
      .filter(Boolean);
    const table = mml(
      "mtable",
      rows
        .map((row) =>
          mml(
            "mtr",
            splitLatexTopLevel(row, "&")
              .map((cell) =>
                mml("mtd", new LatexMathParser(cell.trim(), display).parse()),
              )
              .join(""),
          ),
        )
        .join(""),
    );

    const brackets: Record<string, [string, string]> = {
      pmatrix: ["(", ")"],
      bmatrix: ["[", "]"],
      Bmatrix: ["{", "}"],
      vmatrix: ["|", "|"],
      Vmatrix: ["‖", "‖"],
      cases: ["{", ""],
    };
    const pair = brackets[normalized];
    if (!pair) return table;
    return mml(
      "mrow",
      mmlToken("mo", pair[0], { stretchy: "true" }) +
        table +
        (pair[1] ? mmlToken("mo", pair[1], { stretchy: "true" }) : ""),
    );
  }

  return new LatexMathParser(content, display).parse();
}

class LatexMathParser {
  private pos = 0;

  constructor(
    private readonly src: string,
    private readonly display: boolean,
  ) {}

  parse(): string {
    return this.parseExpression();
  }

  private parseExpression(stopChar?: string): string {
    const nodes: string[] = [];
    while (this.pos < this.src.length) {
      if (stopChar && this.src[this.pos] === stopChar) break;
      const node = this.parseScriptedAtom();
      if (node) nodes.push(node);
    }
    return nodes.join("");
  }

  private parseScriptedAtom(): string {
    this.skipSpaces();
    let base = this.parseAtom();
    if (!base) return "";

    let subscript = "";
    let superscript = "";
    let changed = true;
    while (changed) {
      changed = false;
      this.skipSpaces();
      if (this.peek() === "_") {
        this.pos++;
        subscript = this.parseScriptArgument();
        changed = true;
      }
      this.skipSpaces();
      if (this.peek() === "^") {
        this.pos++;
        superscript = this.parseScriptArgument();
        changed = true;
      }
    }

    if (subscript && superscript) {
      base = mml("msubsup", base + subscript + superscript);
    } else if (subscript) {
      base = mml("msub", base + subscript);
    } else if (superscript) {
      base = mml("msup", base + superscript);
    }

    return base;
  }

  private parseScriptArgument(): string {
    this.skipSpaces();
    if (this.peek() === "{") return this.parseGroup();
    return this.parseAtom();
  }

  private parseAtom(): string {
    this.skipSpaces();
    const ch = this.peek();
    if (!ch) return "";

    if (ch === "}") {
      this.pos++;
      return mmlToken("mo", "}");
    }
    if (ch === "{") return this.parseGroup();
    if (ch === "\\") return this.parseCommand();
    if (/[0-9.]/.test(ch)) return this.parseNumber();
    if (/[A-Za-z]/.test(ch)) {
      this.pos++;
      return mmlToken("mi", ch);
    }

    this.pos++;
    if ("+-=<>≈≠≤≥×÷⋅".includes(ch)) return mmlToken("mo", ch);
    if ("()[]{}|,;:".includes(ch)) return mmlToken("mo", ch);
    return mmlToken("mo", ch);
  }

  private parseGroup(): string {
    if (this.peek() !== "{") return this.parseAtom();
    this.pos++;
    const content = this.parseExpression("}");
    if (this.peek() === "}") this.pos++;
    return mml("mrow", content);
  }

  private parseNumber(): string {
    const start = this.pos;
    while (/[0-9.]/.test(this.peek())) this.pos++;
    return mmlToken("mn", this.src.slice(start, this.pos));
  }

  private parseCommand(): string {
    this.pos++;
    const first = this.peek();
    if (!first) return mmlToken("mo", "\\");

    if (!/[A-Za-z]/.test(first)) {
      this.pos++;
      if (first === "\\") return mml("mspace", "", { linebreak: "newline" });
      if (first === "," || first === ":")
        return mml("mspace", "", { width: "0.2em" });
      if (first === ";") return mml("mspace", "", { width: "0.35em" });
      if (first === "!") return mml("mspace", "", { width: "-0.15em" });
      return mmlToken("mo", first);
    }

    const command = this.readCommandName();
    if (greekCommands[command]) return mmlToken("mi", greekCommands[command]);
    if (symbolCommands[command]) return mmlToken("mo", symbolCommands[command]);
    if (operatorCommands[command])
      return mmlToken("mo", operatorCommands[command]);
    if (functionCommands.has(command)) {
      return mmlToken("mi", command, { mathvariant: "normal" });
    }

    switch (command) {
      case "begin": {
        const env = this.readRawGroup();
        const endTag = `\\end{${env}}`;
        const end = this.src.indexOf(endTag, this.pos);
        if (end === -1) return mmlToken("mtext", `\\begin{${env}}`);
        const content = this.src.slice(this.pos, end);
        this.pos = end + endTag.length;
        return renderLatexEnvironment(env, content, this.display);
      }
      case "frac":
      case "dfrac":
      case "tfrac":
        return mml(
          "mfrac",
          this.parseRequiredArgument() + this.parseRequiredArgument(),
        );
      case "sqrt": {
        const index = this.parseOptionalBracketArgument();
        const radicand = this.parseRequiredArgument();
        return index ? mml("mroot", radicand + index) : mml("msqrt", radicand);
      }
      case "left":
      case "right":
        return this.parseDelimiter();
      case "limits":
      case "nolimits":
      case "displaystyle":
      case "textstyle":
      case "scriptstyle":
      case "scriptscriptstyle":
        return "";
      case "quad":
        return mml("mspace", "", { width: "1em" });
      case "qquad":
        return mml("mspace", "", { width: "2em" });
      case "text":
      case "mbox":
        return mmlToken("mtext", this.readRawGroup());
      case "operatorname":
        return mmlToken("mi", this.readRawGroup(), { mathvariant: "normal" });
      case "mathrm":
        return mml("mstyle", this.parseRequiredArgument(), {
          mathvariant: "normal",
        });
      case "mathbf":
        return mml("mstyle", this.parseRequiredArgument(), {
          mathvariant: "bold",
        });
      case "mathit":
        return mml("mstyle", this.parseRequiredArgument(), {
          mathvariant: "italic",
        });
      case "mathcal":
        return mml("mstyle", this.parseRequiredArgument(), {
          mathvariant: "script",
        });
      case "mathbb":
        return mml("mstyle", this.parseRequiredArgument(), {
          mathvariant: "double-struck",
        });
      case "hat":
        return this.parseAccent("^");
      case "bar":
      case "overline":
        return this.parseAccent("¯");
      case "tilde":
        return this.parseAccent("~");
      case "vec":
        return this.parseAccent("→");
      case "dot":
        return this.parseAccent(".");
      default:
        return mmlToken("mi", command, { mathvariant: "normal" });
    }
  }

  private parseRequiredArgument(): string {
    this.skipSpaces();
    if (this.peek() === "{") return this.parseGroup();
    return this.parseAtom();
  }

  private parseOptionalBracketArgument(): string {
    this.skipSpaces();
    if (this.peek() !== "[") return "";
    this.pos++;
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "{") depth++;
      if (ch === "}") depth = Math.max(0, depth - 1);
      if (ch === "]" && depth === 0) break;
      this.pos++;
    }
    const raw = this.src.slice(start, this.pos);
    if (this.peek() === "]") this.pos++;
    return mml("mrow", new LatexMathParser(raw, this.display).parse());
  }

  private parseAccent(accent: string): string {
    return mml("mover", this.parseRequiredArgument() + mmlToken("mo", accent));
  }

  private parseDelimiter(): string {
    this.skipSpaces();
    let delimiter = this.peek();
    if (!delimiter) return "";
    if (delimiter === "\\") {
      this.pos++;
      const command = /[A-Za-z]/.test(this.peek())
        ? this.readCommandName()
        : this.src[this.pos++] || "";
      delimiter =
        delimiterCommands[command] || symbolCommands[command] || command;
    } else {
      this.pos++;
    }
    if (delimiter === ".") return "";
    return mmlToken("mo", delimiter, { stretchy: "true" });
  }

  private readRawGroup(): string {
    this.skipSpaces();
    if (this.peek() !== "{") return "";
    this.pos++;
    const start = this.pos;
    let depth = 1;
    while (this.pos < this.src.length && depth > 0) {
      const ch = this.src[this.pos];
      if (ch === "\\") {
        this.pos += 2;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      this.pos++;
    }
    return this.src.slice(start, this.pos - 1);
  }

  private readCommandName(): string {
    const start = this.pos;
    while (/[A-Za-z]/.test(this.peek())) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private skipSpaces(): void {
    while (/\s/.test(this.peek())) this.pos++;
  }

  private peek(): string {
    return this.src[this.pos] || "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
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

function resolveFigureImage(
  figures: Map<string, FigureImage>,
  filename: string,
): FigureImage | undefined {
  let image = figures.get(filename);
  if (image) return image;

  const basename = filename.replace(/^.*[/\\]/, "");
  image = figures.get(basename);
  if (image) return image;

  for (const [key, val] of figures) {
    if (
      key.toLowerCase() === filename.toLowerCase() ||
      key.replace(/^.*[/\\]/, "").toLowerCase() === filename.toLowerCase()
    ) {
      return val;
    }
  }

  return undefined;
}

function figureDimensionAttrs(image: FigureImage): string {
  if (!image.width || !image.height) return "";
  return ` width="${Math.round(image.width)}" height="${Math.round(image.height)}"`;
}

function figureImgTag(image: FigureImage, altText: string): string {
  return `<img src="${image.dataURI}" alt="${escapeAttr(altText)}"${figureDimensionAttrs(image)} style="max-width:100%;height:auto;border:0;">`;
}

function postProcessFigures(
  md: string,
  figures: Map<string, FigureImage>,
): string {
  return md.replace(
    /\[\[FIGURE:([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, placeholder, altText, imgPath) => {
      const filename = placeholder
        ? placeholder.trim()
        : (imgPath || "").trim();
      if (!filename) return _match;

      const image = resolveFigureImage(figures, filename);
      if (!image) {
        ztoolkit.log("[AI Parse] Figure not found:", filename);
        return `\n<p style="color:#999;font-style:italic;">[图: ${escapeHtml(altText || filename)}]</p>\n`;
      }
      const alt = altText || placeholder || filename;
      // Bare <img> — markdownToHtml will wrap it in <p> naturally.
      // Wrapping our own <p> here would cause double-nesting and break rendering.
      return `\n${figureImgTag(image, alt)}\n`;
    },
  );
}

async function createChildNote(
  item: Zotero.Item,
  content: string,
  model: string,
  figureBase64Map?: Map<string, FigureImage>,
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
      "<h2>📷 提取的图片</h2>",
    ];
    for (const [filename, image] of figureBase64Map) {
      figuresHtml.push(
        `<p style="text-align:center;margin:16px 0;">`,
        figureImgTag(image, filename),
        `</p>`,
        `<p style="color:#6b7280;text-align:center;">${escapeHtml(filename)}</p>`,
      );
    }
    figuresHtml.push("</div>");
    html += figuresHtml.join("\n");
    ztoolkit.log(
      `[AI Parse] Appended ${figureBase64Map.size} figure(s) at end of note`,
    );
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
  options: AIParseOptions = {},
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
      await parseItemWithAI(item, options);
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
