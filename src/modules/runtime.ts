import { getPref, setPref } from "../utils/prefs";

const RUNTIME_ROOT_NAME = "zoteroai-runtime";
const PLATFORM = "win-x64";
const MODEL_FILENAME = "doclayout_yolo_docstructbench_imgsz1024.pt";
const BOOTSTRAP_ARCHIVE = "python-bootstrap-win-x64.zip";

const PIP_INSTALL_STEPS = [
  ["-m", "pip", "install", "--upgrade", "--no-cache-dir", "pip"],
  [
    "-m",
    "pip",
    "install",
    "--upgrade",
    "--no-cache-dir",
    "torch",
    "torchvision",
    "--index-url",
    "https://download.pytorch.org/whl/cpu",
  ],
  [
    "-m",
    "pip",
    "install",
    "--upgrade",
    "--no-cache-dir",
    "pymupdf",
    "huggingface_hub",
    "doclayout-yolo",
  ],
];

export interface FigureRuntimeAssets {
  scriptPath: string;
  modelPath: string | null;
}

export interface RuntimeStatus {
  supported: boolean;
  installed: boolean;
  pythonPath: string | null;
  assetsReady: boolean;
  message: string;
}

function getRuntimeRoot(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, RUNTIME_ROOT_NAME);
}

function getAssetsDir(): string {
  return PathUtils.join(getRuntimeRoot(), "assets");
}

function getManagedRuntimeDir(): string {
  return PathUtils.join(getRuntimeRoot(), PLATFORM);
}

function getManagedPythonPath(): string {
  return PathUtils.join(getManagedRuntimeDir(), "python.exe");
}

function getManagedPythonwPath(): string {
  return PathUtils.join(getManagedRuntimeDir(), "pythonw.exe");
}

function getBootstrapArchivePath(): string {
  return PathUtils.join(getRuntimeRoot(), BOOTSTRAP_ARCHIVE);
}

function isGenericPythonPath(path: string): boolean {
  const normalized = path
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  return ["python", "python.exe", "pythonw.exe", "py", "py.exe"].includes(
    normalized,
  );
}

function toPythonwPath(path: string): string {
  const trimmed = path.trim();
  const pythonw = trimmed.replace(/python\.exe$/i, "pythonw.exe");
  return pythonw || trimmed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await IOUtils.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await IOUtils.makeDirectory(path, { createAncestors: true });
}

async function copyTextResource(
  resourcePath: string,
  targetPath: string,
): Promise<void> {
  const text = await Zotero.File.getResourceAsync(rootURI + resourcePath);
  const parent = PathUtils.parent(targetPath);
  if (parent) {
    await ensureDirectory(parent);
  }
  await Zotero.File.putContentsAsync(targetPath, text);
}

async function copyBinaryResourceIfMissing(
  resourcePath: string,
  targetPath: string,
): Promise<boolean> {
  if (await pathExists(targetPath)) {
    return true;
  }

  const parent = PathUtils.parent(targetPath);
  if (parent) {
    await ensureDirectory(parent);
  }

  try {
    await Zotero.File.download(rootURI + resourcePath, targetPath);
    return true;
  } catch (e) {
    ztoolkit.log("[AI Parse] Cannot copy bundled resource:", resourcePath, e);
    return false;
  }
}

export async function ensureFigureRuntimeAssets(): Promise<FigureRuntimeAssets> {
  const assetsDir = getAssetsDir();
  const scriptPath = PathUtils.join(assetsDir, "extract_figures.py");
  const modelPath = PathUtils.join(assetsDir, "models", MODEL_FILENAME);

  await ensureDirectory(PathUtils.join(assetsDir, "models"));
  await copyTextResource("python/extract_figures.py", scriptPath);

  const copiedModel = await copyBinaryResourceIfMissing(
    `python/models/${MODEL_FILENAME}`,
    modelPath,
  );

  return {
    scriptPath,
    modelPath: copiedModel ? modelPath : null,
  };
}

export async function resolveFigurePythonPath(
  options: { preferConsole?: boolean } = {},
): Promise<string | null> {
  const configured = ((getPref("pythonPath") as string) || "").trim();
  const managedPath = options.preferConsole
    ? getManagedPythonPath()
    : getManagedPythonwPath();

  if (await pathExists(managedPath)) {
    return managedPath;
  }

  if (configured && !isGenericPythonPath(configured)) {
    return options.preferConsole ? configured : toPythonwPath(configured);
  }

  const managedConsole = getManagedPythonPath();
  if (await pathExists(managedConsole)) {
    return managedConsole;
  }

  return configured || "python";
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!Zotero.isWin) {
    return {
      supported: false,
      installed: false,
      pythonPath: null,
      assetsReady: false,
      message: "当前仅支持 Windows x64。",
    };
  }

  const pythonPath = await resolveFigurePythonPath({ preferConsole: true });
  const installed =
    (await pathExists(getManagedPythonPath())) ||
    Boolean(pythonPath && !isGenericPythonPath(pythonPath));

  let assetsReady: boolean;
  try {
    const assets = await ensureFigureRuntimeAssets();
    assetsReady = Boolean(assets.scriptPath && assets.modelPath);
  } catch {
    assetsReady = false;
  }

  return {
    supported: true,
    installed,
    pythonPath,
    assetsReady,
    message: installed
      ? assetsReady
        ? "运行时和内置模型已就绪。"
        : "运行时已就绪，但内置模型未找到。"
      : "运行时未安装。请点击安装按钮。",
  };
}

async function copyBootstrapArchiveIfPresent(): Promise<boolean> {
  return copyBinaryResourceIfMissing(
    `runtime/${PLATFORM}/${BOOTSTRAP_ARCHIVE}`,
    getBootstrapArchivePath(),
  );
}

async function unzipArchive(zipPath: string, targetDir: string): Promise<void> {
  const zipReader = (Components.classes as any)[
    "@mozilla.org/libjar/zip-reader;1"
  ].createInstance(Components.interfaces.nsIZipReader) as nsIZipReader;

  zipReader.open(Zotero.File.pathToFile(zipPath));
  try {
    const entries = zipReader.findEntries("*");
    while (entries.hasMore()) {
      const entry = entries.getNext();
      const normalized = entry.replace(/\\/g, "/");
      if (
        !normalized ||
        normalized.startsWith("/") ||
        normalized.split("/").includes("..")
      ) {
        continue;
      }

      const targetPath = PathUtils.join(targetDir, ...normalized.split("/"));
      if (normalized.endsWith("/")) {
        await ensureDirectory(targetPath);
        continue;
      }

      const parent = PathUtils.parent(targetPath);
      if (parent) {
        await ensureDirectory(parent);
      }
      await Zotero.File.removeIfExists(targetPath);
      zipReader.extract(entry, Zotero.File.pathToFile(targetPath));
    }
  } finally {
    zipReader.close();
  }
}

async function ensureBootstrapRuntime(): Promise<string> {
  if (await pathExists(getManagedPythonPath())) {
    return getManagedPythonPath();
  }

  const hasArchive = await copyBootstrapArchiveIfPresent();
  if (hasArchive) {
    await ensureDirectory(getManagedRuntimeDir());
    await unzipArchive(getBootstrapArchivePath(), getManagedRuntimeDir());
    if (await pathExists(getManagedPythonPath())) {
      return getManagedPythonPath();
    }
  }

  const configured = ((getPref("pythonPath") as string) || "").trim();
  if (configured) {
    return configured;
  }

  return "python";
}

async function execPython(pythonPath: string, args: string[]): Promise<void> {
  const result = await Zotero.Utilities.Internal.exec(pythonPath, args);
  if (result instanceof Error) {
    throw result;
  }
}

export async function installFigureRuntime(): Promise<RuntimeStatus> {
  if (!Zotero.isWin) {
    throw new Error("当前仅支持 Windows x64。");
  }

  await ensureFigureRuntimeAssets();

  const pythonPath = await ensureBootstrapRuntime();
  for (const args of PIP_INSTALL_STEPS) {
    await execPython(pythonPath, args);
  }

  await execPython(pythonPath, [
    "-c",
    "import fitz, doclayout_yolo, huggingface_hub; print('zoteroai-runtime-ok')",
  ]);

  if (await pathExists(getManagedPythonPath())) {
    setPref("pythonPath", getManagedPythonPath());
  }

  return getRuntimeStatus();
}
