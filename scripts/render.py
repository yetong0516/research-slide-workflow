#!/usr/bin/env python3
"""Optional LibreOffice + pdftoppm rendering for visual QA; never edits the PPTX."""
import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('pptx')
    ap.add_argument('--out', default='build/preview')
    args = ap.parse_args()
    source, out = Path(args.pptx).resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    soffice = shutil.which('soffice') or shutil.which('libreoffice')
    pdftoppm = shutil.which('pdftoppm')
    if not soffice or not pdftoppm:
        raise SystemExit('Install LibreOffice and Poppler, or open the PPTX in PowerPoint/WPS for visual QA.')
    with tempfile.TemporaryDirectory(prefix='research-slide-lo-') as profile:
        subprocess.run([soffice, '-env:UserInstallation=' + Path(profile).as_uri(),
                        '--headless', '--convert-to', 'pdf', '--outdir', str(out), str(source)],
                       check=True, timeout=120)
    pdf = out / (source.stem + '.pdf')
    if not pdf.is_file():
        raise SystemExit('LibreOffice did not produce a PDF.')
    subprocess.run([pdftoppm, '-png', '-scale-to', '1600', str(pdf), str(out / 'slide')],
                   check=True, timeout=120)
    print(f'Rendered {pdf}; inspect every slide PNG individually.')
