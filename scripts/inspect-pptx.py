#!/usr/bin/env python3
"""Inspect saved PPTX structure with Python stdlib, without editing the file."""
import argparse
import importlib.util
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}


def inspect_pptx(filename):
    with zipfile.ZipFile(filename) as z:
        if z.testzip():
            raise ValueError('Broken ZIP member')
        names = z.namelist()
        types = ET.fromstring(z.read('[Content_Types].xml'))
        for entry in types:
            if entry.tag.endswith('Override'):
                target = entry.attrib.get('PartName', '').lstrip('/')
                if target not in names:
                    raise ValueError(f'Content type names a missing package part: {target}')
        pages = sorted((n for n in names if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)),
                       key=lambda n: int(re.search(r'(\d+)\.xml', n).group(1)))
        result = []
        for page in pages:
            root = ET.fromstring(z.read(page))
            text = [e.text or '' for e in root.findall('.//a:t', NS)]
            result.append({'part': page, 'text': text,
                           'nativeTextShapes': len(root.findall('.//p:sp/p:txBody', NS)),
                           'images': len(root.findall('.//p:pic', NS)),
                           'graphicFrames': len(root.findall('.//p:graphicFrame', NS))})
        dims = ET.fromstring(z.read('ppt/presentation.xml')).find('p:sldSz', NS)
        result = {'path': str(Path(filename).resolve()), 'slideCount': len(pages),
                'slideSizeEmu': dims.attrib if dims is not None else None,
                'nativeChartCount': sum(bool(re.fullmatch(r'ppt/charts/chart\d+\.xml', n)) for n in names),
                'slides': result}
    helper_path = Path(__file__).resolve().parents[1] / 'skills/research-slide-workflow/scripts/inspect_pptx_images.py'
    spec = importlib.util.spec_from_file_location('inspect_pptx_images', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    result['imageFallbacks'] = helper.inspect_pptx_images(filename)
    return result


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('pptx')
    ap.add_argument('--expected-slides', type=int)
    ap.add_argument('--out')
    ap.add_argument('--check-image-fallbacks', action='store_true',
                    help='Exit 1 for confirmed SVG raster fallback errors; the default only reports them')
    args = ap.parse_args()
    result = inspect_pptx(args.pptx)
    if args.expected_slides is not None and result['slideCount'] != args.expected_slides:
        raise SystemExit(f"Expected {args.expected_slides} slides, found {result['slideCount']}")
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output, encoding='utf-8')
    else:
        print(output)
    if args.check_image_fallbacks and result['imageFallbacks']['errorCount']:
        raise SystemExit(1)
