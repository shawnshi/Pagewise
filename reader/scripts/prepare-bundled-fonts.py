"""Package already-downloaded upstream fonts without subsetting or changing names.

Run from the repository root with fonttools==4.63.0 and brotli==1.2.0 on
PYTHONPATH. Inputs live in .cache/font-embedding/upstream; no network is used.
The shipping manifest records upstream URLs, hashes, versions and coverage.
"""
import hashlib
import json
import shutil
from functools import partial
from pathlib import Path
from unittest.mock import patch

from fontTools.ttLib import TTFont, woff2  # type: ignore[import-not-found]

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.cache/font-embedding/upstream'
DEST = ROOT / 'reader/public/fonts'
SPECS = [
    ('SourceHanSerifSC-VF.woff2', 'SourceHanSerifSC-VF.woff2', 'https://raw.githubusercontent.com/adobe-fonts/source-han-serif/2.003R/Variable/WOFF2/OTF/SourceHanSerifSC-VF.otf.woff2', 'SourceHanSerif-LICENSE.txt'),
    ('SourceHanSansSC-VF.woff2', 'SourceHanSansSC-VF.woff2', 'https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/Variable/WOFF2/OTF/SourceHanSansSC-VF.otf.woff2', 'SourceHanSans-LICENSE.txt'),
    ('Literata.ttf', 'Literata-Regular.woff2', 'https://raw.githubusercontent.com/googlefonts/literata/main/fonts/variable/Literata%5Bopsz,wght%5D.ttf', 'Literata-OFL.txt'),
    ('Literata-Italic.ttf', 'Literata-Italic.woff2', 'https://raw.githubusercontent.com/googlefonts/literata/main/fonts/variable/Literata-Italic%5Bopsz,wght%5D.ttf', 'Literata-OFL.txt'),
    ('LXGWWenKaiScreen.ttf', 'LXGWWenKaiScreen.woff2', 'https://github.com/lxgw/LxgwWenKai-Screen/releases/download/v1.522/LXGWWenKaiScreen.ttf', 'LXGWWenKaiScreen-OFL.txt'),
    ('SourceSerif4-Roman.otf', 'SourceSerif4-Regular.woff2', 'https://raw.githubusercontent.com/adobe-fonts/source-serif/4.005R/VAR/SourceSerif4Variable-Roman.otf', 'SourceSerif4-LICENSE.md'),
    ('SourceSerif4-Italic.otf', 'SourceSerif4-Italic.woff2', 'https://raw.githubusercontent.com/adobe-fonts/source-serif/4.005R/VAR/SourceSerif4Variable-Italic.otf', 'SourceSerif4-LICENSE.md'),
]
SAMPLES = {
    'han': '阅读閱讀藏繁鬱龘赵趙臺台里裏骨令遍直返边邊“”‘’——……，。！？、；：',
    'rare_han': '𠮷𡃁𠮶𠀀𰻞',
    'latin_greek': 'Café naïve façade Ångström œuvre ẞ Ελληνικά αβγ Ω',
    'symbols': '₀₁₂₃⁰¹²³∑∫√∞ IPA əɪʃʒŋɜ',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata(font):
    cmap = font.getBestCmap()
    gsub = font['GSUB'].table if 'GSUB' in font else None
    langs = sorted({lang.LangSysTag.strip() for script in gsub.ScriptList.ScriptRecord
                    if script.ScriptTag == 'hani' for lang in script.Script.LangSysRecord}) if gsub else []
    return {
        'family': font['name'].getDebugName(1),
        'style': font['name'].getDebugName(2),
        'version': font['name'].getDebugName(5),
        'italic': bool(font['head'].macStyle & 2),
        'glyphs': font['maxp'].numGlyphs,
        'encodedCodepoints': len(cmap),
        'axes': {a.axisTag: [a.minValue, a.defaultValue, a.maxValue] for a in font['fvar'].axes} if 'fvar' in font else {},
        'haniLanguages': langs,
        'features': sorted({f.FeatureTag for f in gsub.FeatureList.FeatureRecord}) if gsub else [],
        'missingSamples': {key: ''.join(dict.fromkeys(c for c in text if ord(c) not in cmap)) for key, text in SAMPLES.items()},
    }


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    lock = DEST / 'manifest.json'
    expected = {f['file']: f for f in json.loads(lock.read_text(encoding='utf-8'))['fonts']} if lock.exists() else {}
    for original, output, _url, license_name in SPECS:
        known = expected.get(output)
        if known and (sha(SOURCE / original) != known['sourceSha256'] or sha(SOURCE / license_name) != known['licenseSha256']):
            raise ValueError(f'Upstream hash drift: {output}; review the font update before repackaging')
    result = []
    for original, output, url, license_name in SPECS:
        source = SOURCE / original
        target = DEST / output
        known = expected.get(output)
        if known and target.exists() and sha(target) == known['sha256'] and (DEST / license_name).exists() and sha(DEST / license_name) == known['licenseSha256']:
            result.append(known)
            print(output, 'verified unchanged')
            continue
        with TTFont(source, recalcTimestamp=False) as font:
            before = metadata(font)
            source_cmap = font.getBestCmap()
            if source.suffix == '.woff2':
                shutil.copyfile(source, target)
            else:
                # WOFF2 is a container conversion; preserve all glyphs, names and axes.
                font.flavor = 'woff2'
                # Quality 11 takes minutes on the 47k-glyph WenKai; quality 5
                # changes compression ratio only, not outlines or coverage.
                with patch.object(woff2.brotli, 'compress', partial(woff2.brotli.compress, quality=5)):
                    font.save(target)
        with TTFont(target) as font:
            assert metadata(font) == before, f'Metadata changed: {output}'
            assert font.getBestCmap() == source_cmap, f'Coverage changed: {output}'
        shutil.copyfile(SOURCE / license_name, DEST / license_name)
        result.append({
            'file': output, 'source': url, 'sourceSha256': sha(source),
            'sha256': sha(target), 'bytes': target.stat().st_size,
            'license': license_name, 'licenseSha256': sha(DEST / license_name),
            **before,
        })
        print(output, target.stat().st_size, before['version'])
    manifest = {'format': 1, 'packagedOn': '2026-10-18', 'tooling': {'fonttools': '4.63.0', 'brotli': '1.2.0', 'brotliQuality': 5}, 'fonts': result}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('TOTAL:', sum(x['bytes'] for x in result))


if __name__ == '__main__':
    main()
