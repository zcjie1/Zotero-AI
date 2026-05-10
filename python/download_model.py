"""
Zotero AI — 下载 DocLayout-YOLO 模型

直接通过 huggingface_hub 下载模型文件到本地缓存，
绕过 doclayout-yolo 0.0.4 中 from_pretrained 的 GitHub release 检查 bug。

用法:
  D:\Code\zotero-ai\python\.venv\python.exe download_model.py
"""

from __future__ import annotations

import os
import sys


def main():
    # 国内镜像（连不上可注释掉这行）
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    MODEL_ID = "juliozhao/DocLayout-YOLO-DocStructBench"

    print(f"[1/2] 下载模型文件: {MODEL_ID}")
    print(f"    端点: {os.environ.get('HF_ENDPOINT', 'huggingface.co')}")
    print("    （首次约需 1-5 分钟...）")

    try:
        from huggingface_hub import snapshot_download

        local_path = snapshot_download(MODEL_ID)
    except ImportError:
        print("错误：huggingface_hub 未安装")
        print("  conda run --prefix python/.venv pip install huggingface_hub")
        sys.exit(1)
    except Exception as e:
        print(f"下载失败: {e}")
        print("建议: 注释掉 HF_ENDPOINT 那行用官方端点重试")
        sys.exit(1)

    print(f"\n[2/2] 验证...")
    try:
        from doclayout_yolo import YOLOv10
        YOLOv10(local_path)
        print("    ✅ 模型加载成功！")
    except ImportError:
        print("    (doclayout-yolo 未安装，跳过验证)")
    except Exception as e:
        print(f"    警告: {e}")

    print(f"\n✅ 完成: {local_path}")
    for f in sorted(os.listdir(local_path)):
        fp = os.path.join(local_path, f)
        if os.path.isfile(fp):
            mb = os.path.getsize(fp) / (1024 * 1024)
            print(f"    {f} ({mb:.1f} MB)")


if __name__ == "__main__":
    main()
