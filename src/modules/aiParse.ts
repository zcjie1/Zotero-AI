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

const CHAT_TIMEOUT = 180000; // 3 minutes for AI analysis

// ---------------------------------------------------------------------------
// Core: text extraction + chat
// ---------------------------------------------------------------------------

async function buildTextContent(pdf: Zotero.Item): Promise<string | null> {
  const filename = pdf.getField("filename") || "document.pdf";
  const extracted = await getAttText(pdf);
  if (!extracted || extracted.trim().length === 0) return null;
  return `### ${filename}\n\`\`\`\n${extracted}\n\`\`\``;
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

  const userMsg = [
    `请分析以下论文内容。`,
    `条目标题: ${itemTitle}`,
    ``,
    ...contents,
  ].join("\n");

  const result = await sendChatRequest(
    chatEndpoint, apiKey, model, systemPrompt,
    userMsg, maxTokens, temperature,
  );

  if (!result) throw new Error(getString("ai-parse-error-no-content"));

  await createChildNote(item, result, model);
}

// ---------------------------------------------------------------------------
// Note creation
// ---------------------------------------------------------------------------

function markdownToHtml(md: string): string {
  // Pre-process: protect LaTeX math blocks $$...$$ before line-based processing
  const mathBlocks: string[] = [];
  let processed = md.replace(/\$\$([\s\S]*?)\$\$/g, (_m, formula) => {
    const idx = mathBlocks.length;
    mathBlocks.push(`<div style="text-align:center;margin:8px 0;padding:8px;background:#f3f0ff;border-radius:4px;font-family:monospace;font-size:13px;">$$${formula.trim()}$$</div>`);
    return `\x00MATHBLOCK${idx}\x00`;
  });

  // Pre-process: protect inline math $...$
  const mathInlines: string[] = [];
  processed = processed.replace(/\$([^$\n]+?)\$/g, (_m, formula) => {
    const idx = mathInlines.length;
    mathInlines.push(`<code style="background:#f3f0ff;color:#6d28d9;padding:1px 4px;border-radius:3px;font-size:12px;">$${formula}$</code>`);
    return `\x00MATHINLINE${idx}\x00`;
  });

  const lines = processed.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        out.push("</code></pre>");
        inCodeBlock = false;
      } else {
        out.push('<pre><code>');
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
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("<hr>");
      continue;
    }

    // Headers
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      if (inList) { out.push("</ul>"); inList = false; }
      const level = hMatch[1].length;
      out.push(`<h${level}>${inlineFormat(hMatch[2])}</h${level}>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (inList) { out.push("</ul>"); }
      out.push(`<p>${inlineFormat(line.trim())}</p>`);
      continue;
    }

    // End list if we were in one
    if (inList) { out.push("</ul>"); inList = false; }

    // Empty line → paragraph break
    if (line.trim() === "") {
      continue;
    }

    // Regular paragraph
    out.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inList) out.push("</ul>");
  if (inCodeBlock) out.push("</code></pre>");

  let result = out.join("\n");

  // Restore math blocks
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
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

async function createChildNote(
  item: Zotero.Item,
  content: string,
  model: string,
): Promise<void> {
  const showHeader = getPref("showHeader") as boolean;
  const headerMd = `*AI 解析 (${model}) — ${new Date().toLocaleString()}*\n\n---\n\n`;
  const finalContent = showHeader ? headerMd + content : content;
  const note = new Zotero.Item("note");
  note.setNote(markdownToHtml(finalContent));
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
      results[idx].error = e instanceof Error
        ? e.message
        : (e && typeof e === "object" ? JSON.stringify(e) : String(e));
      ztoolkit.log("Parse error:", item.id, results[idx].error);
    }
    onStatusChange([...results]);
  });

  await Promise.allSettled(tasks);

  const success = results.filter((r) => r.status === "done").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return { success, failed };
}
