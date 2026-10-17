"""Validate Android-only Pagewise metadata and source-derived icon contracts."""
from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tomllib
import unittest
import xml.etree.ElementTree as ET

from PIL import Image, ImageOps

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT.parent / "artifacts/android-only-baseline/reader"
DESCRIPTION = "面向文石 Note X3 Pro 的个人 EPUB 阅读器。专注阅读，随页理解。"
LOGO_HASH = "6240730e5ea653bb777afa8750e2abccf0098b26bda24df9f0ab074edd0a7d62"
SPEC = importlib.util.spec_from_file_location("pagewise_branding", ROOT / "scripts/prepare-branding.py")
assert SPEC and SPEC.loader
BRANDING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRANDING)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def json_file(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in {path}: {error}") from error


def toml_file(path: Path):
    return tomllib.loads(path.read_text(encoding="utf-8"))


class BrandingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json_file(ROOT / "src-tauri/icons/source/icon-manifest.json")
        cls.logo = ROOT / "public/pagewise-logo.png"

    def test_duplicate_json_brand_fields_rejected(self):
        with self.assertRaises(ValueError):
            unique_object([("description", "old"), ("description", "new")])

    def test_logo_provenance(self):
        self.assertEqual(hashlib.sha256(self.logo.read_bytes()).hexdigest(), LOGO_HASH)
        workspace_logo = ROOT.parent / "Pagewise.png"
        if workspace_logo.exists():
            self.assertEqual(workspace_logo.read_bytes(), self.logo.read_bytes())
        self.assertEqual(self.manifest["brand"]["source_sha256"], LOGO_HASH)

    def test_npm_and_cargo_identity(self):
        package = json_file(ROOT / "package.json")
        lock = json_file(ROOT / "package-lock.json")
        cargo = toml_file(ROOT / "src-tauri/Cargo.toml")
        cargo_lock = toml_file(ROOT / "src-tauri/Cargo.lock")
        self.assertEqual([package["name"], lock["name"], lock["packages"][""]["name"], cargo["package"]["name"]], ["pagewise"] * 4)
        self.assertEqual(package["description"], DESCRIPTION)
        self.assertEqual(cargo["package"]["description"], DESCRIPTION)
        self.assertEqual(cargo["lib"]["name"], "pagewise_lib")
        self.assertFalse((ROOT / "src-tauri/src/main.rs").exists())
        self.assertFalse(cargo["package"]["autobins"])
        roots = [item for item in cargo_lock["package"] if item["name"] == "pagewise"]
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["version"], package["version"])

    def test_tauri_and_android_identity(self):
        config = json_file(ROOT / "src-tauri/tauri.conf.json")
        self.assertEqual(config["identifier"], "io.pagewise.reader")
        self.assertEqual(config["productName"], "知页")
        self.assertEqual(config["app"]["windows"][0]["title"], "知页")
        self.assertEqual(config["bundle"]["android"]["debugApplicationIdSuffix"], ".debug")
        self.assertEqual(config["bundle"]["shortDescription"], "专注阅读，随页理解。")
        self.assertEqual(config["bundle"]["longDescription"], DESCRIPTION)
        self.assertEqual(config["bundle"]["targets"], [])
        self.assertEqual(config["bundle"]["icon"], ["icons/icon.png"])
        activity = (ROOT / "src-tauri/android/MainActivity.kt").read_text(encoding="utf-8")
        self.assertTrue(activity.startswith("package io.pagewise.reader\n"))
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertIn("prepare-android-project.mjs", workflow)
        self.assertIn("Pagewise_${RELEASE_TAG}_android_arm64.apk", workflow)
        self.assertNotIn("LightRead_${RELEASE_TAG}", workflow)

    def test_frontend_name_description_and_logo_seams(self):
        for locale in ("zh", "en"):
            text = (ROOT / f"src/i18n/{locale}.ts").read_text(encoding="utf-8")
            self.assertIn("'app.name': '知页'", text)
            self.assertIn("'app.fullName': '知页阅读器 · Pagewise'", text)
            self.assertIn("'settings.tagline': '专注阅读，随页理解。'", text)
            self.assertIn("'settings.upstreamCredit':", text)
            self.assertNotIn("'settings.desktopVersion':", text)
            self.assertIn("'settings.previewVersion':", text)
        app = (ROOT / "src/App.vue").read_text(encoding="utf-8")
        about = (ROOT / "src/views/SettingsView.vue").read_text(encoding="utf-8")
        self.assertIn('src="/pagewise-logo.png"', app)
        self.assertNotIn('id="logo-bg"', app)
        self.assertIn('src="/pagewise-logo.png"', about)
        for key in ("app.fullName", "app.description", "settings.upstreamCredit"):
            self.assertIn(f"t('{key}')", about)
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("<title>知页阅读器 · Pagewise</title>", html)
        self.assertIn(DESCRIPTION, html)
        self.assertNotIn("VitePWA", (ROOT / "vite.config.ts").read_text(encoding="utf-8"))

    def test_every_derived_png_is_android_or_shared_and_sized(self):
        targets = self.manifest["derived_icons"]
        paths = [item["path"] for item in targets]
        self.assertEqual(self.manifest["platforms"], ["android"])
        self.assertEqual(len(paths), 26)
        self.assertEqual(len(paths), len(set(paths)))
        actual = {path.relative_to(ROOT).as_posix() for path in (ROOT / "src-tauri/icons").rglob("*.png")}
        self.assertEqual(set(paths), actual)
        for target in targets:
            with self.subTest(path=target["path"]), Image.open(ROOT / target["path"]) as image:
                image.load()
                self.assertEqual(image.size, (target["width"], target["height"]))
                self.assertEqual(image.mode, "RGBA")
                self.assertTrue(target["path"].startswith("src-tauri/icons/android/") or target["path"] == "src-tauri/icons/icon.png")

    def test_standard_icon_derives_from_original_pixels(self):
        with Image.open(self.logo) as logo, Image.open(ROOT / "src-tauri/icons/icon.png") as icon:
            expected = ImageOps.contain(logo.convert("RGBA"), icon.size, Image.Resampling.LANCZOS)
            self.assertEqual(icon.convert("RGBA").tobytes(), expected.tobytes())

    def test_android_background_is_not_a_second_logo(self):
        for target in self.manifest["derived_icons"]:
            if target["path"].endswith("/ic_launcher_background.png"):
                self.assertEqual(target["variant"], "background")
                with Image.open(ROOT / target["path"]) as image:
                    self.assertEqual(image.convert("RGBA").getextrema(), ((255, 255),) * 4)
        adaptive = ET.parse(ROOT / "src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml").getroot()
        background = adaptive.find("background")
        self.assertIsNotNone(background)
        assert background is not None
        self.assertEqual(background.attrib["{http://schemas.android.com/apk/res/android}drawable"], "@mipmap/ic_launcher_background")

    def test_adaptive_foreground_and_monochrome_safe_circle(self):
        for target in self.manifest["derived_icons"]:
            if target["variant"] not in {"foreground", "monochrome"}:
                continue
            with self.subTest(path=target["path"]), Image.open(ROOT / target["path"]) as image:
                alpha = image.getchannel("A")
                self.assertEqual(alpha.getextrema(), (0, 255))
                box = alpha.point([255 if value > 128 else 0 for value in range(256)]).getbbox()
                self.assertIsNotNone(box)
                assert box is not None
                self.assertLessEqual(math.hypot(box[2] - box[0], box[3] - box[1]), target["width"] * 0.62 + 1)
                self.assertEqual(alpha.getpixel((0, 0)), 0)

    def test_round_icons_have_transparent_corners(self):
        for target in self.manifest["derived_icons"]:
            if target["variant"] == "round":
                with Image.open(ROOT / target["path"]) as image:
                    self.assertEqual(image.getchannel("A").getpixel((0, 0)), 0)
                    self.assertEqual(image.getchannel("A").getpixel((image.width - 1, image.height - 1)), 0)

    def test_svg_assets_embed_local_logo_only(self):
        for name in ("public/favicon.svg", "src-tauri/icons/source/app-icon.svg", "src-tauri/icons/source/android-fg.svg", "src-tauri/icons/source/android-monochrome.svg"):
            image = ET.parse(ROOT / name).find("{http://www.w3.org/2000/svg}image")
            self.assertIsNotNone(image)
            assert image is not None
            href = image.attrib["href"]
            self.assertTrue(href.startswith("data:image/png;base64,"))
            with Image.open(io.BytesIO(base64.b64decode(href.split(",", 1)[1], validate=True))) as embedded:
                embedded.verify()

    def test_removed_platform_icons_are_not_regenerated(self):
        for name in ("src-tauri/icons/icon.ico", "src-tauri/icons/icon.icns", "src-tauri/icons/ios", "public/icon-192.png", "public/icon-512.png", "public/icon-maskable-512.png"):
            self.assertFalse((ROOT / name).exists(), name)
        self.assertFalse(any((ROOT / "src-tauri/icons").glob("Square*Logo.png")))
        with self.assertRaises(ValueError):
            BRANDING.render(Image.new("RGBA", (32, 32), "white"), 32, 32, "maskable")

    def test_generator_rejects_non_icon_paths_and_empty_glyph(self):
        for name in ("../outside.png", "public/icon-192.png", "src-tauri/icons/../../package.json", "src-tauri/icons/test.txt"):
            with self.subTest(path=name), self.assertRaises(ValueError):
                BRANDING.icon_path(name)
        with self.assertRaises(ValueError):
            BRANDING.glyph_mask(Image.new("RGBA", (32, 32), "white"))
        manifest = copy.deepcopy(self.manifest)
        manifest["brand"]["source_png"] = "../outside.png"
        with self.assertRaises(ValueError):
            BRANDING.read_source(manifest)

    def test_release_checker_and_repository_versions(self):
        for arguments in (("--self-test",), ()):
            result = subprocess.run(["node", "scripts/check-release.mjs", *arguments], cwd=ROOT, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(BASELINE.exists(), "Task snapshot is not part of the standalone fork")
    def test_retained_dependency_versions_and_data_contracts_unchanged(self):
        package = json_file(ROOT / "package.json")
        old_package = json_file(BASELINE / "package.json")
        self.assertEqual(package["version"], old_package["version"])
        self.assertEqual(set(old_package["dependencies"]) - set(package["dependencies"]), {"node-unrar-js"})
        for name, version in package["dependencies"].items():
            self.assertEqual(version, old_package["dependencies"][name])
        removed = {"@cloudflare/vite-plugin", "vite-plugin-pwa", "wrangler"}
        self.assertEqual(set(old_package["devDependencies"]) - set(package["devDependencies"]), removed)
        for name, version in package["devDependencies"].items():
            self.assertEqual(version, old_package["devDependencies"][name])
        lock = json_file(ROOT / "package-lock.json")["packages"]
        old_lock = json_file(BASELINE / "package-lock.json")["packages"]
        self.assertTrue(set(lock).issubset(old_lock))
        for name, data in lock.items():
            if not name:
                continue
            for field in ("version", "resolved", "integrity"):
                self.assertEqual(data.get(field), old_lock[name].get(field), (name, field))
        cargo_lock = toml_file(ROOT / "src-tauri/Cargo.lock")["package"]
        old_cargo_lock = toml_file(BASELINE / "src-tauri/Cargo.lock")["package"]
        old = {(p["name"], p["version"], p.get("source", "")): p for p in old_cargo_lock}
        for entry in cargo_lock:
            previous = old[(entry["name"], entry["version"], entry.get("source", ""))]
            self.assertEqual(entry.get("checksum"), previous.get("checksum"))
        config = json_file(ROOT / "src-tauri/tauri.conf.json")
        original = json_file(BASELINE / "src-tauri/tauri.conf.json")
        self.assertEqual(config["app"]["security"], original["app"]["security"])
        active_extensions = {extension for entry in config["bundle"]["fileAssociations"] for extension in entry["ext"]}
        self.assertEqual(active_extensions, {"epub", "mobi", "pdf", "txt", "md", "markdown"})
        for path in ("src/services/ai.ts", "src/services/edgeTts.ts"):
            self.assertEqual((ROOT / path).read_bytes(), (BASELINE / path).read_bytes(), path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
