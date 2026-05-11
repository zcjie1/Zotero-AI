import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { parseItemsWithAI, type AIParseOptions } from "./modules/aiParse";
import { config } from "../package.json";
import { DialogHelper } from "zotero-plugin-toolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register preference pane
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
  });

  // Register item right-click context menu (Zotero 8+ API)
  Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-item-parse-menu`,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: buildParseModeMenus(),
  });

  // Register File menu item
  Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-file-parse-menu`,
    pluginID: config.addonID,
    target: "main/menubar/file",
    menus: buildParseModeMenus(),
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  // Load localization for the main window
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Handle AI parsing of selected items
 */
function buildParseModeMenus(): _ZoteroTypes.MenuManager.MenuData[] {
  return [
    {
      menuType: "menuitem",
      l10nID: `${config.addonRef}-menuitem-ai-parse-reuse`,
      onCommand: async (_event: Event, _context: unknown) => {
        await onAIParseSelected({ figureCacheMode: "reuse" });
      },
    },
    {
      menuType: "menuitem",
      l10nID: `${config.addonRef}-menuitem-ai-parse-refresh`,
      onCommand: async (_event: Event, _context: unknown) => {
        await onAIParseSelected({ figureCacheMode: "refresh" });
      },
    },
  ];
}

async function onAIParseSelected(options: AIParseOptions) {
  const zp = Zotero.getActiveZoteroPane();
  if (!zp) return;

  const selectedItems = zp.getSelectedItems();
  if (!selectedItems || selectedItems.length === 0) {
    showError(getString("ai-parse-error-no-selection"));
    return;
  }

  const regularItems = selectedItems.filter((item: Zotero.Item) =>
    item.isRegularItem(),
  );

  if (regularItems.length === 0) {
    showError(getString("ai-parse-error-no-regular-item"));
    return;
  }

  // Close previous dialog if any
  addon.data.dialog?.window?.close();

  // Build the dialog
  const dialog = buildStatusDialog(regularItems);
  addon.data.dialog = dialog;

  // Start parallel parsing (don't await, let it run in background)
  runParallelParse(dialog, regularItems, options);
}

// ---------------------------------------------------------------------------
// Dialog helpers
// ---------------------------------------------------------------------------

function showError(msg: string) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({ text: msg, type: "warning", progress: 100 })
    .show();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const STATUS_ICONS: Record<string, string> = {
  pending: "\u23F3",
  parsing: "\uD83D\uDD04",
  done: "\u2705",
  failed: "\u274C",
};

function buildStatusDialog(items: Zotero.Item[]): DialogHelper {
  // Build item list HTML with unique ids
  const rows = items
    .map(
      (it) =>
        `<div style="display:flex;align-items:flex-start;gap:6px;padding:4px 0;border-bottom:1px solid var(--fill-quarternary, #e5e7eb);">` +
        `<span id="zoteroai-icon-${it.id}" style="font-size:15px;flex-shrink:0;">${STATUS_ICONS.pending}</span>` +
        `<span id="zoteroai-text-${it.id}" style="flex:1;font-size:13px;color:inherit;">${escapeHtml(it.getDisplayTitle())}</span>` +
        `</div>`,
    )
    .join("");

  const bodyHtml =
    `<div style="min-width:420px;min-height:120px;max-height:450px;overflow-y:auto;padding:8px;" id="zoteroai-status-body">` +
    rows +
    `<div id="zoteroai-status-summary" style="margin-top:8px;text-align:center;font-size:13px;color:inherit;opacity:0.7;font-weight:600;">准备开始解析 ${items.length} 个条目...</div>` +
    `</div>`;

  const dlg: any = new (DialogHelper as any)(1, 1);
  dlg
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      attributes: {
        style:
          "min-width:420px;min-height:120px;max-height:450px;overflow-y:auto;padding:8px;",
      },
      properties: { innerHTML: bodyHtml },
    })
    .addButton("解析中...", "btn-close", { noClose: false })
    .setDialogData({ _lastButtonId: "" })
    .open("AI \u89E3\u6790\u72B6\u6001", {
      width: 540,
      height: 400,
      centerscreen: true,
      resizable: true,
      fitContent: false,
    });

  return dlg as DialogHelper;
}

async function runParallelParse(
  dialog: DialogHelper,
  items: Zotero.Item[],
  options: AIParseOptions,
) {
  const win = dialog.window;
  if (!win) return;

  const summaryEl = win.document.getElementById("zoteroai-status-summary");

  try {
    const { success, failed } = await parseItemsWithAI(
      items,
      (results) => {
        for (const r of results) {
          const iconEl = win.document.getElementById(
            `zoteroai-icon-${r.item.id}`,
          );
          const textEl = win.document.getElementById(
            `zoteroai-text-${r.item.id}`,
          );
          if (iconEl) iconEl.textContent = STATUS_ICONS[r.status] || "\u2753";
          if (textEl) {
            if (r.error) {
              textEl.innerHTML = `${escapeHtml(r.title)} <span style="color:#ef4444;font-size:11px;">(${escapeHtml(r.error)})</span>`;
            }
          }
          if (summaryEl) {
            const done = results.filter(
              (x) => x.status === "done" || x.status === "failed",
            ).length;
            summaryEl.innerHTML = `<span style="color:inherit;opacity:0.7;font-weight:600;">${done}/${results.length} 已完成</span>`;
          }
        }
      },
      options,
    );

    if (summaryEl) {
      if (failed === 0) {
        summaryEl.innerHTML = `<span style="color:#10b981;font-weight:600;font-size:14px;">\u2705 全部完成！共 ${success} 篇</span>`;
      } else {
        summaryEl.innerHTML = `<span style="color:#f59e0b;font-weight:600;font-size:14px;">\u2705 ${success} 篇 / \u274C ${failed} 篇</span>`;
      }
    }
    const closeBtn = win.document.querySelector("button") as HTMLElement | null;
    if (closeBtn) closeBtn.textContent = "\u5173\u95ED";
  } catch (e) {
    if (summaryEl) {
      summaryEl.innerHTML = `<span style="color:#ef4444;font-weight:600;">\u51FA\u9519: ${escapeHtml(e instanceof Error ? e.message : String(e))}</span>`;
    }
    const closeBtn = win.document.querySelector("button") as HTMLElement | null;
    if (closeBtn) closeBtn.textContent = "\u5173\u95ED";
  }
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // Can be used to react to Zotero events
  ztoolkit.log("notify", event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(_type: string) {
  // Reserved for keyboard shortcuts
}

function onDialogEvents(_type: string) {
  // Reserved for dialog events
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
