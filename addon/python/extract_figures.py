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

# Patterns to extract media numbers from captions.
# Matches: "Figure 3", "Fig. 4", "Table 1", "Algorithm 2", "Alg. 3(a)", etc.
_CAPTION_ID_RE = re.compile(
    r"\b(?P<kind>Figure|Fig\.?|Table|Algorithm|Alg\.?)\s*"
    r"(?P<num>\d+(?:(?:[.\-][a-zA-Z0-9]+)|(?:\([a-zA-Z0-9]+\)))*)",
    re.IGNORECASE,
)
_CAPTION_HEADER_RE = re.compile(
    r"^\s*(?:\([a-zA-Z0-9]+\)\s*)*"
    r"(?:Figure|Fig\.?|Table|Algorithm|Alg\.?)\s*"
    r"\d+(?:(?:[.\-][a-zA-Z0-9]+)|(?:\([a-zA-Z0-9]+\)))*",
    re.IGNORECASE,
)
_FALLBACK_PREFIX = {
    "figure": "Fig",
    "table": "Table",
    "algorithm": "Alg",
}


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


def _normalize_region_kind(label_raw: str) -> str | None:
    """Normalize layout labels to the media kind used in filenames."""
    label = label_raw.strip().lower()
    if "caption" in label:
        return None
    if "algorithm" in label or label in {"alg", "algo"}:
        return "algorithm"
    if "table" in label:
        return "table"
    if "figure" in label or label == "fig":
        return "figure"
    return None


def _looks_like_caption_text(text: str) -> bool:
    """Return True for real caption headers, not body refs like 'see Fig. 1'."""
    normalized = " ".join(text.split())
    return bool(_CAPTION_HEADER_RE.search(normalized))


def _normalize_caption_number(num: str) -> str:
    return (
        num.replace("(", "_")
        .replace(")", "")
        .replace(".", "_")
        .replace("-", "_")
    )


def _caption_kind_prefix(kind_text: str) -> str:
    kind = kind_text.lower().rstrip(".")
    if kind in {"table"}:
        return "Table"
    if kind in {"algorithm", "alg"}:
        return "Alg"
    return "Fig"


def _caption_region_kind(caption: str) -> str | None:
    m = _CAPTION_ID_RE.search(caption)
    if not m:
        return None
    prefix = _caption_kind_prefix(m.group("kind"))
    if prefix == "Table":
        return "table"
    if prefix == "Alg":
        return "algorithm"
    return "figure"


def _fallback_id(region_kind: str, index: int) -> str:
    return f"{_FALLBACK_PREFIX.get(region_kind, 'Fig')}{index}"


def _infer_item_id(caption: str, fallback: str) -> str:
    """Extract a stable media id from caption text.

    Examples:
      "Figure 3." -> "Fig3"
      "Table 2: Results" -> "Table2"
      "Algorithm 1 Training" -> "Alg1"

    Falls back to *fallback* if no number is found.
    """
    m = _CAPTION_ID_RE.search(caption)
    if not m:
        return fallback
    prefix = _caption_kind_prefix(m.group("kind"))
    num = _normalize_caption_number(m.group("num"))
    return f"{prefix}{num}"


def _horizontal_overlap_ratio(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> float:
    overlap = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    width = max(1.0, min(a[2] - a[0], b[2] - b[0]))
    return min(1.0, overlap / width)


def _vertical_distance(
    media_box: tuple[float, float, float, float],
    caption_box: tuple[float, float, float, float],
) -> float:
    if caption_box[1] >= media_box[3]:
        return caption_box[1] - media_box[3]
    if media_box[1] >= caption_box[3]:
        return media_box[1] - caption_box[3]
    return 0.0


def _caption_match_score(
    media_box: tuple[float, float, float, float],
    caption_box: tuple[float, float, float, float],
) -> float:
    gap = _vertical_distance(media_box, caption_box)
    if gap > 160:
        return -1.0
    horizontal = _horizontal_overlap_ratio(media_box, caption_box)
    below_bonus = 0.3 if caption_box[1] >= media_box[3] else 0.05
    return horizontal * 2.0 + (1.0 / (1.0 + gap / 30.0)) + below_bonus


def _collect_caption_blocks(
    text_blocks: list[tuple],
    caption_regions: list[tuple[float, float, float, float]],
) -> list[tuple[float, float, float, float, str]]:
    captions: list[tuple[float, float, float, float, str]] = []
    seen: set[tuple[int, int, int, int, str]] = set()

    for block in text_blocks:
        bx0, by0, bx1, by1, btext, *_ = block
        text = " ".join(str(btext).split())
        if not text:
            continue

        bbox = (float(bx0), float(by0), float(bx1), float(by1))
        region_match = any(
            _horizontal_overlap_ratio(bbox, region) > 0.4
            and _vertical_distance(bbox, region) < 30
            for region in caption_regions
        )
        if not _looks_like_caption_text(text) and not (
            region_match and _CAPTION_ID_RE.search(text)
        ):
            continue

        key = (
            round(bbox[0]),
            round(bbox[1]),
            round(bbox[2]),
            round(bbox[3]),
            text,
        )
        if key in seen:
            continue
        seen.add(key)
        captions.append((*bbox, text))

    return sorted(captions, key=lambda item: (item[1], item[0]))


def _select_caption_for_region(
    media_box: tuple[float, float, float, float],
    captions: list[tuple[float, float, float, float, str]],
) -> tuple[float, float, float, float, str] | None:
    best = None
    best_score = -1.0
    for caption in captions:
        score = _caption_match_score(media_box, caption[:4])
        if score > best_score:
            best = caption
            best_score = score
    return best if best_score > 0 else None


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
    fallback_counts = {"figure": 0, "table": 0, "algorithm": 0}

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

        # Collect figure/table/algorithm regions + caption regions
        names = results[0].names
        media_boxes: list[dict] = []
        caption_regions: list[tuple[float, float, float, float]] = []

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

            region_kind = _normalize_region_kind(label_raw)
            if region_kind:
                media_boxes.append(
                    {
                        "bbox": pdf_box,
                        "score": float(box.conf[0]),
                        "kind": region_kind,
                        "label": label_raw,
                    }
                )
            elif "caption" in label:
                caption_regions.append(pdf_box)

        if not media_boxes:
            continue

        text_blocks = page.get_text("blocks")
        caption_blocks = _collect_caption_blocks(text_blocks, caption_regions)
        media_boxes.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))

        # For each media box, find the nearest real caption text
        for media in media_boxes:
            if len(figures) >= max_figures:
                break

            fx0, fy0, fx1, fy1 = media["bbox"]
            score = media["score"]
            region_kind = media["kind"]
            caption_text = ""
            best_caption = _select_caption_for_region(
                media["bbox"],
                caption_blocks,
            )

            if best_caption:
                caption_text = best_caption[4]
                region_kind = _caption_region_kind(caption_text) or region_kind

            # Derive id from caption BEFORE cropping (so the filename reflects
            # the paper's own media number: Figure 3 -> Fig3, Table 1 -> Table1).
            fallback_counts[region_kind] += 1
            fallback_id = _fallback_id(region_kind, fallback_counts[region_kind])
            fig_id = _infer_item_id(caption_text, fallback_id)

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
                    fy1
                    + pad
                    + (
                        min(80.0, max(0.0, best_caption[3] - fy1 + 4.0))
                        if best_caption and best_caption[1] >= fy1
                        else 0.0
                    ),
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
                        "kind": region_kind,
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

def build_arg_parser() -> argparse.ArgumentParser:
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
    return parser


def main() -> None:
    parser = build_arg_parser()

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
