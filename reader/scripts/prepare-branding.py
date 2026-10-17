"""Derive Pagewise application icons from the unchanged workspace logo (Pillow)."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "src-tauri/icons/source/icon-manifest.json"
RESAMPLE = Image.Resampling.LANCZOS


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".pagewise-tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def image_bytes(image: Image.Image, format: str = "PNG", **options) -> bytes:
    stream = io.BytesIO()
    image.save(stream, format=format, **options)
    return stream.getvalue()


def read_source(manifest: dict) -> tuple[bytes, Image.Image]:
    if manifest["brand"]["source_png"] != "public/pagewise-logo.png":
        raise ValueError("Unexpected logo source path")
    workspace_source = ROOT.parent / "Pagewise.png"
    path = workspace_source if workspace_source.is_file() else ROOT / manifest["brand"]["source_png"]
    content = path.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != manifest["brand"]["source_sha256"]:
        raise ValueError("Logo differs from the approved Pagewise.png; do not silently regenerate a new brand")
    with Image.open(io.BytesIO(content)) as source:
        source.load()
        return content, source.convert("RGBA")


def glyph_mask(source: Image.Image) -> Image.Image:
    # Android monochrome/foreground assets need transparency, not an opaque white square.
    on_white = Image.new("RGBA", source.size, "white")
    on_white.alpha_composite(source)
    mask = ImageOps.invert(on_white.convert("L")).point([max(0, (value - 24) * 255 // 231) for value in range(256)])
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError("Approved logo has no visible foreground")
    return mask.crop(bounds)


def render(source: Image.Image, width: int, height: int, variant: str) -> Image.Image:
    if width != height or width < 16:
        raise ValueError("Unexpected icon dimensions")
    if variant == "background":
        return Image.new("RGBA", (width, height), "white")
    if variant == "standard":
        canvas = Image.new("RGBA", (width, height), "white")
        fitted = ImageOps.contain(source, (width, height), RESAMPLE)
        canvas.alpha_composite(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))
        return canvas
    if variant not in {"foreground", "monochrome", "round"}:
        raise ValueError(f"Unknown icon variant: {variant}")
    mask = glyph_mask(source)
    if variant in {"foreground", "monochrome"}:
        # Android reserves a 66dp diameter safe circle inside a 108dp foreground.
        scale = width * 0.60 / math.hypot(mask.width, mask.height)
        mask = mask.resize((max(1, round(mask.width * scale)), max(1, round(mask.height * scale))), RESAMPLE)
    else:
        side = max(1, round(width * 0.60))
        mask = ImageOps.contain(mask, (side, side), RESAMPLE)
    canvas = Image.new("RGBA", (width, height), "white" if variant == "round" else (0, 0, 0, 0))
    ink = Image.new("RGBA", mask.size, "black")
    ink.putalpha(mask)
    canvas.alpha_composite(ink, ((width - mask.width) // 2, (height - mask.height) // 2))
    if variant == "round":
        circle = Image.new("L", (width * 4, height * 4), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, width * 4 - 1, height * 4 - 1), fill=255)
        canvas.putalpha(ImageChops.multiply(canvas.getchannel("A"), circle.resize((width, height), RESAMPLE)))
    return canvas


def svg(image: Image.Image, title: str) -> bytes:
    payload = base64.b64encode(image_bytes(image)).decode("ascii")
    width, height = image.size
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">'
            f'<title>{title}</title><image width="{width}" height="{height}" href="data:image/png;base64,{payload}"/></svg>\n').encode()


def icon_path(relative: str) -> Path:
    candidate = ROOT / relative
    in_icons = candidate.resolve().is_relative_to((ROOT / "src-tauri/icons").resolve())
    if not candidate.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("Icon output escapes the project")
    if candidate.suffix != ".png" or not in_icons:
        raise ValueError(f"Output is outside the approved icon set: {relative}")
    return candidate


def prepare(preview: Path | None = None) -> dict:
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid branding manifest: {error}") from error
    content, source = read_source(manifest)
    targets = manifest["derived_icons"]
    if len({item["path"] for item in targets}) != len(targets):
        raise ValueError("Duplicate icon output")
    paths = [icon_path(item["path"]) for item in targets]
    atomic_write(ROOT / "public/pagewise-logo.png", content)
    for item, path in zip(targets, paths, strict=True):
        image = render(source, item["width"], item["height"], item["variant"])
        atomic_write(path, image_bytes(image))
    sources = ROOT / "src-tauri/icons/source"
    atomic_write(sources / "app-icon.svg", svg(source, "知页阅读器 · Pagewise"))
    atomic_write(sources / "android-fg.svg", svg(render(source, 108, 108, "foreground"), "知页"))
    atomic_write(sources / "android-monochrome.svg", svg(render(source, 108, 108, "monochrome"), "知页"))
    atomic_write(sources / "android-bg.svg", b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><rect width="108" height="108" fill="#FFFFFF"/></svg>\n')
    atomic_write(ROOT / "public/favicon.svg", svg(render(source, 128, 128, "standard"), "知页"))
    if preview is not None:
        sheet = Image.new("RGB", (840, 300), "#eeeeee")
        draw = ImageDraw.Draw(sheet)
        for i, variant in enumerate(("standard", "foreground", "monochrome", "background", "round")):
            x = 16 + i * 166
            tile = Image.new("RGBA", (150, 150), "white")
            tile.alpha_composite(render(source, 128, 128, variant), (11, 11))
            sheet.paste(tile.convert("RGB"), (x, 36))
            draw.text((x, 206), variant, fill="black")
            for j, size in enumerate((16, 32, 48)):
                small = render(source, size, size, "standard")
                sheet.paste(small.convert("RGB"), (x + j * 50, 240))
        atomic_write(preview, image_bytes(sheet))
    return {"pngIcons": len(targets), "sourceSha256": manifest["brand"]["source_sha256"], "sourceUnchanged": hashlib.sha256(content).hexdigest() == manifest["brand"]["source_sha256"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="Explicit optional contact-sheet output path")
    args = parser.parse_args()
    print(json.dumps(prepare(args.preview), ensure_ascii=False))
