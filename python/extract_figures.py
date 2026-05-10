"""
Zotero AI — PDF Figure Extractor CLI

Lightweight command-line tool called by the zoteroai Zotero plugin.
Extracts figure/table images from a PDF using DocLayout-YOLO + PyMuPDF.

Usage:
  python extract_figures.py <pdf_path> <output_dir> [--max-figures 3]

Output:
  <output_dir>/
    _status.json    → written immediately on startup ("running")
    figures.json     → { "figures": [{"id":"Fig1","caption":"...","path":"Fig1.png"},...] }
    Fig1.png, ...    → Cropped figure images (220 DPI)
    _error.json      → written on failure with diagnostic info
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from pathlib import Path

# When run via pythonw.exe (no console window on Windows), sys.stdout and
# sys.stderr are None.  doclayout_yolo crashes on 'sys.stdout.encoding'.
# Patch them to /dev/null BEFORE any doclayout_yolo import happens.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

# 国内镜像，与 download_model.py 保持一致
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Patterns to extract figure/table numbers from captions.
# Matches: "Figure 3", "Fig. 4", "Figure 5.2", "Fig 6(a)", "Table 1", etc.
_FIGURE_NUM_RE = re.compile(
    r"(?:Figure|Fig\.?|Table)\s+"
    r"(\d+(?:\.[a-zA-Z0-9]+|\([a-zA-Z0-9]+\))?)",
    re.IGNORECASE,
)


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _write_error(out_dir: Path, message: str) -> None:
    """Write _error.json so the TS plugin can read diagnostic info."""
    _ensure_dir(out_dir)
    (out_dir / "_error.json").write_text(
        json.dumps({"error": message}, ensure_ascii=False),
        encoding="utf-8",
    )


def _write_status(out_dir: Path, status: str, extra: dict | None = None) -> None:
    """Write _status.json for TS-side progress tracking."""
    _ensure_dir(out_dir)
    payload = {"status": status}
    if extra:
        payload.update(extra)
    (out_dir / "_status.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def _infer_figure_id(caption: str, fallback: str) -> str:
    """Extract figure number from caption; e.g. 'Figure 3.' → 'Fig3'.

    Falls back to *fallback* if no number is found.
    """
    m = _FIGURE_NUM_RE.search(caption)
    if m:
        num = m.group(1).replace("(", "_").replace(")", "").replace(".", "_")
        return f"Fig{num}"
    return fallback


def _resolve_model_file(model_ref: str) -> str | None:
    """Find the .pt model file locally, WITHOUT any network calls.

    Checks (in order):
    1. model_ref is already a .pt file → return it
    2. model_ref is a directory with .pt files → return first .pt
    3. Try huggingface_hub cache for the known .pt filename (local-only)
    4. snapshot_download with local_files_only=True
    """
    ref = Path(model_ref)

    # 1) Direct .pt file
    if ref.exists() and ref.is_file():
        return str(ref.resolve())

    # 2) Local directory
    if ref.exists() and ref.is_dir():
        pt_files = sorted(ref.glob("*.pt"))
        if pt_files:
            return str(pt_files[0].resolve())

    # 3) HuggingFace cache — local-only, no network
    try:
        from huggingface_hub import try_to_load_from_cache
        cached = try_to_load_from_cache(
            repo_id=model_ref,
            filename="doclayout_yolo_docstructbench_imgsz1024.pt",
        )
        if cached and Path(cached).exists():
            return cached  # return .pt file path, NOT directory
    except Exception:
        pass

    # 4) snapshot_download with local_files_only=True (no network)
    try:
        from huggingface_hub import snapshot_download
        local_dir = Path(snapshot_download(
            model_ref,
            local_files_only=True,
        ))
        pt_files = sorted(local_dir.glob("*.pt"))
        if pt_files:
            return str(pt_files[0].resolve())  # return .pt file path
    except Exception:
        pass

    return None


# ---------------------------------------------------------------------------
# Main extraction logic
# ---------------------------------------------------------------------------

def extract_figures(
    pdf_path: Path,
    output_dir: Path,
    *,
    max_figures: int = 5,
    confidence: float = 0.1,
    device: str = "cpu",
    crop_dpi: int = 220,
    render_dpi: int = 150,
    model_path: str = "juliozhao/DocLayout-YOLO-DocStructBench",
) -> list[dict]:
    """Extract figure images from a PDF.

    Returns a list of dicts:
        [{"id": "Fig1", "caption": "...", "path": "Fig1.png"}, ...]
    """
    try:
        import fitz
    except ImportError:
        _write_error(output_dir, "PyMuPDF (fitz) is not installed")
        sys.exit(1)

    try:
        from doclayout_yolo import YOLOv10
    except ImportError:
        _write_error(output_dir, "doclayout-yolo is not installed")
        sys.exit(1)

    _ensure_dir(output_dir)

    # Write startup signal immediately so TS can confirm the script is running
    _write_status(output_dir, "running", {"pdf": str(pdf_path), "max_figures": max_figures})

    document = fitz.open(str(pdf_path))
    figures: list[dict] = []
    seen_ids: set[str] = set()

    # --- Load layout model ---
    # doclayout-yolo 0.0.4's from_pretrained has a GitHub release check bug.
    # Resolve to a local .pt file WITHOUT network calls — the model should
    # already be cached by download_model.py.
    local_model = _resolve_model_file(model_path)
    if not local_model:
        _write_error(output_dir, f"Model not found: {model_path}. Run download_model.py first.")
        sys.exit(1)

    model = YOLOv10(local_model)

    for page_num in range(len(document)):
        if len(figures) >= max_figures:
            break

        page = document[page_num]
        page_w = page.rect.width
        page_h = page.rect.height

        # Render page
        pix = page.get_pixmap(dpi=render_dpi, alpha=False)
        page_png = output_dir / f"_page_{page_num + 1:03d}.png"
        pix.save(str(page_png))

        # Layout detection
        results = model.predict(
            str(page_png),
            imgsz=1024,
            conf=confidence,
            device=device,
            verbose=False,
        )
        # Clean up temp page PNG immediately
        page_png.unlink(missing_ok=True)

        if not results:
            continue

        # Collect figure/table regions + captions
        names = results[0].names
        # (x0, y0, x1, y1, score)
        figure_boxes: list[tuple[float, float, float, float, float]] = []
        # (x0, y0, x1, y1, text)
        caption_boxes: list[tuple[float, float, float, float, str]] = []

        # Determine scale from rendered image to PDF coords
        img_w, img_h = pix.width, pix.height
        scale_x = page_w / float(img_w or 1)
        scale_y = page_h / float(img_h or 1)

        for box in results[0].boxes:
            label_raw = names.get(int(box.cls[0]), "")
            label = label_raw.lower()
            xyxy = box.xyxy[0].tolist()
            pdf_box = (
                xyxy[0] * scale_x,
                xyxy[1] * scale_y,
                xyxy[2] * scale_x,
                xyxy[3] * scale_y,
            )

            if label in ("figure", "fig", "table"):
                figure_boxes.append((*pdf_box, float(box.conf[0])))
            elif label == "caption":
                caption_boxes.append(pdf_box + (label_raw,))

        if not figure_boxes:
            continue

        # For each figure box, find the nearest caption text
        for _idx, (fx0, fy0, fx1, fy1, score) in enumerate(figure_boxes):
            if len(figures) >= max_figures:
                break

            caption_text = ""

            # Find closest caption (nearest below the figure)
            best_caption = None
            best_gap = float("inf")
            for cx0, cy0, cx1, cy1, ctext in caption_boxes:
                gap = cy0 - fy1
                if 0 <= gap < best_gap and gap < 100:
                    best_gap = gap
                    best_caption = (cx0, cy0, cx1, cy1, ctext)

            # Extract caption text from page text blocks
            if best_caption:
                cx0, cy0, cx1, cy1, ctext = best_caption
                blocks = page.get_text("blocks")
                for block in blocks:
                    bx0, by0, bx1, by1, btext, *_ = block
                    if (
                        abs(bx0 - cx0) < 20
                        and abs(by0 - cy0) < 20
                        and abs(bx1 - cx1) < 50
                        and abs(by1 - cy1) < 20
                    ):
                        caption_text = btext.strip()
                        break
                if not caption_text:
                    caption_text = ctext

            # Derive figure id from caption BEFORE cropping (so the filename
            # reflects the paper's own figure number, e.g. "Figure 3" → Fig3).
            fallback_id = f"Fig{len(figures) + 1}"
            fig_id = _infer_figure_id(caption_text, fallback_id) if caption_text else fallback_id

            if fig_id in seen_ids:
                suffix = 2
                while f"{fig_id}_{suffix}" in seen_ids:
                    suffix += 1
                fig_id = f"{fig_id}_{suffix}"

            # Crop figure region with padding
            pad = 4.0
            crop_rect = fitz.Rect(
                max(0, fx0 - pad),
                max(0, fy0 - pad),
                min(page_w, fx1 + pad),
                min(
                    page_h,
                    fy1 + pad + (30 if best_caption else 0),
                ),
            )
            fig_pix = page.get_pixmap(
                clip=crop_rect, dpi=crop_dpi, alpha=False
            )
            fig_path = output_dir / f"{fig_id}.png"
            fig_pix.save(str(fig_path))

            # Sanity check: skip tiny images (likely false positives)
            file_size = fig_path.stat().st_size
            if file_size < 500:
                fig_path.unlink(missing_ok=True)
                continue

            if fig_id not in seen_ids:
                seen_ids.add(fig_id)
                figures.append(
                    {
                        "id": fig_id,
                        "caption": caption_text,
                        "path": f"{fig_id}.png",
                        "page": page_num + 1,
                        "confidence": round(score, 4),
                    }
                )

    document.close()

    # Write metadata
    meta_path = output_dir / "figures.json"
    meta_path.write_text(
        json.dumps({"figures": figures}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Write success status
    _write_status(output_dir, "done", {"count": len(figures)})

    return figures


# ---------------------------------------------------------------------------
# CLI entry
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Zotero AI — PDF Figure Extractor"
    )
    parser.add_argument("pdf_path", type=Path, help="Path to the PDF file")
    parser.add_argument(
        "output_dir", type=Path, help="Directory to store extracted figures"
    )
    parser.add_argument(
        "--max-figures",
        type=int,
        default=5,
        help="Max figures to extract (default: 5)",
    )
    parser.add_argument(
        "--confidence",
        type=float,
        default=0.1,
        help="YOLO confidence threshold (default: 0.1)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default="cpu",
        choices=["cpu", "cuda"],
        help="Device for YOLO (default: cpu)",
    )
    parser.add_argument(
        "--crop-dpi",
        type=int,
        default=220,
        help="DPI for cropped figures (default: 220)",
    )
    parser.add_argument(
        "--render-dpi",
        type=int,
        default=150,
        help="DPI for page rendering (default: 150)",
    )
    parser.add_argument(
        "--model-path",
        type=str,
        default="juliozhao/DocLayout-YOLO-DocStructBench",
        help="DocLayout-YOLO model path or HF repo",
    )

    args = parser.parse_args()

    if not args.pdf_path.exists():
        print(f"ERROR: PDF not found: {args.pdf_path}", file=sys.stderr)
        sys.exit(1)

    try:
        figures = extract_figures(
            args.pdf_path,
            args.output_dir,
            max_figures=args.max_figures,
            confidence=args.confidence,
            device=args.device,
            crop_dpi=args.crop_dpi,
            render_dpi=args.render_dpi,
            model_path=args.model_path,
        )
    except Exception as exc:
        _write_error(args.output_dir, str(exc))
        _write_status(args.output_dir, "error", {"error": str(exc)})
        sys.exit(1)

    # Print result summary to stdout (parsed by the TS plugin)
    print(
        json.dumps(
            {"ok": True, "count": len(figures), "figures": figures},
            ensure_ascii=False,
        )
    )

if __name__ == "__main__":
    # Grab output_dir early so we can write _error.json even when
    # Python crashes before argparse (e.g. import failures).
    out_dir: Path | None = None
    for i, arg in enumerate(sys.argv):
        if arg == "--max-figures":
            continue  # skip flag + value
        if arg.startswith("-"):
            continue  # skip other flags
        # pdf_path and output_dir are the two positional args
        if out_dir is None and i >= 2 and not arg.startswith("-"):
            out_dir = Path(arg) if i == 2 else out_dir
    # Simpler: sys.argv[1]=pdf, sys.argv[2]=output_dir, sys.argv[3:]=optional
    if len(sys.argv) > 2 and not sys.argv[2].startswith("-"):
        out_dir = Path(sys.argv[2])

    try:
        main()
    except BaseException as exc:
        # Don't intercept clean exit (SystemExit code 0)
        if isinstance(exc, SystemExit) and exc.code == 0:
            raise
        msg = f"{exc}\n{traceback.format_exc()}"
        print(f"FATAL: {msg}", file=sys.stderr)
        if out_dir is not None:
            try:
                _write_error(out_dir, msg)
            except Exception as we:
                print(f"FATAL: could not write _error.json: {we}", file=sys.stderr)
        sys.exit(1)
