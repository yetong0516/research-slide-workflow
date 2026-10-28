import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import JSZip from 'jszip';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELPER = path.join(ROOT, 'skills/research-slide-workflow/scripts/inspect_pptx_images.py');
const INSPECTOR = path.join(ROOT, 'scripts/inspect-pptx.py');
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SVG = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';
const packageRels = inner => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const rel = (id, target, type = 'image') => `<Relationship Id="${id}" Target="${target}" Type="${R}/${type}"/>`;
const picture = (name, fallback, svg = 'vector') => `<p:pic><p:nvPicPr><p:cNvPr id="1" name="${name}"/></p:nvPicPr><p:blipFill><a:blip${fallback ? ` r:embed="${fallback}"` : ''}>${svg ? `<a:extLst><a:ext uri="svg"><asvg:svgBlip r:embed="${svg}"/></a:ext></a:extLst>` : ''}</a:blip></p:blipFill></p:pic>`;
const slide = inner => `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:asvg="${SVG}"><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const kind = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([size, kind, data, crc]);
}

function png({width = 2, height = 2, alpha = 255, filter = 0, depth = 8} = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = 6;
  const previous = Buffer.alloc(width * 4), rows = [];
  for (let y = 0; y < height; y++) {
    const pixels = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) pixels.set([30 + x, 70 + y, 120, alpha], x * 4);
    const encoded = Buffer.alloc(pixels.length + 1); encoded[0] = filter;
    for (let i = 0; i < pixels.length; i++) {
      const a = i >= 4 ? pixels[i - 4] : 0, b = previous[i], c = i >= 4 ? previous[i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      encoded[i + 1] = (pixels[i] - [0, a, b, Math.floor((a + b) / 2), paeth][filter]) & 255;
    }
    pixels.copy(previous); rows.push(encoded);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

async function withFixture(extra, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pptx-image-fallbacks-'));
  const filename = path.join(dir, 'deck.pptx');
  try {
    const zip = new JSZip();
    const entries = {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': packageRels(rel('slide', 'slides/slide1.xml', 'slide')),
      'ppt/slides/slide1.xml': slide(picture('SVG picture', 'raster')),
      'ppt/slides/_rels/slide1.xml.rels': packageRels(rel('vector', '../media/vector.svg') + rel('raster', '../media/fallback.png')),
      'ppt/media/vector.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
      'ppt/media/fallback.png': png(),
      ...extra,
    };
    for (const [name, bytes] of Object.entries(entries)) if (bytes !== null) zip.file(name, bytes);
    await fs.writeFile(filename, await zip.generateAsync({type: 'nodebuffer'}));
    const before = await fs.readFile(filename);
    await fn(filename);
    assert.deepEqual(await fs.readFile(filename), before, 'inspection must not rewrite the source PPTX');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

function inspect(filename, {script = HELPER, strict = false} = {}) {
  const flag = script === INSPECTOR ? '--check-image-fallbacks' : '--fail-on-error';
  const run = spawnSync(process.env.PYTHON || 'python3', [script, filename, ...(strict ? [flag] : [])], {encoding: 'utf8'});
  assert.ifError(run.error);
  assert.equal(run.stderr, '', run.stderr);
  const data = JSON.parse(run.stdout);
  return {status: run.status, report: script === INSPECTOR ? data.imageFallbacks : data, data};
}

test('a missing fallback part is reported and strict checking fails without editing the deck', async () => {
  await withFixture({'ppt/media/fallback.png': null}, filename => {
    const {status, report} = inspect(filename, {strict: true});
    assert.equal(status, 1);
    assert.equal(report.svgPictureCount, 1);
    assert.equal(report.pictures[0].status, 'error');
    assert.ok(report.pictures[0].issues.some(i => i.code === 'missing_fallback_part'));
  });
});

test('missing fallback embeds and missing relationships are distinguished', async () => {
  for (const [fallback, code] of [[null, 'missing_fallback'], ['absent', 'missing_fallback_relationship']]) {
    await withFixture({'ppt/slides/slide1.xml': slide(picture('No usable fallback', fallback))}, filename => {
      const {report} = inspect(filename);
      assert.ok(report.pictures[0].issues.some(i => i.code === code));
    });
  }
});

test('fully transparent RGBA fallbacks are detected for all five PNG row filters', async () => {
  for (let filter = 0; filter <= 4; filter++) {
    await withFixture({'ppt/media/fallback.png': png({alpha: 0, filter})}, filename => {
      const {status, report} = inspect(filename, {strict: true});
      assert.equal(status, 1, `PNG filter ${filter}`);
      assert.equal(report.pictures[0].png.fullyTransparent, true);
      assert.ok(report.pictures[0].issues.some(i => i.code === 'transparent_fallback'));
      assert.ok(!report.pictures[0].issues.some(i => i.code === 'one_pixel_fallback'));
    });
  }
});

test('a one-pixel SVG fallback is rejected even when its pixel is opaque', async () => {
  await withFixture({'ppt/media/fallback.png': png({width: 1, height: 1})}, filename => {
    const {report} = inspect(filename, {strict: true});
    assert.ok(report.pictures[0].issues.some(i => i.code === 'one_pixel_fallback'));
    assert.equal(report.pictures[0].png.fullyTransparent, false);
  });
});

test('fallbacks are paired within each picture and relative or root targets are resolved', async () => {
  await withFixture({
    'ppt/slides/slide1.xml': slide(picture('Ordinary one-pixel picture', 'ordinary', null)
      + picture('First SVG', 'correct') + picture('Second SVG', 'absolute', 'vector2')),
    'ppt/slides/_rels/slide1.xml.rels': packageRels(rel('ordinary', '../media/one.png')
      + rel('unused', '../media/unused.png') + rel('vector', '../media/vector.svg')
      + rel('correct', '../media/./nested/../valid%20fallback.png')
      + rel('vector2', '/ppt/media/second.svg') + rel('absolute', '/ppt/media/second.png')),
    'ppt/media/one.png': png({width: 1, height: 1, alpha: 0}),
    'ppt/media/unused.png': png({width: 1, height: 1, alpha: 0}),
    'ppt/media/valid fallback.png': png(),
    'ppt/media/second.png': png({filter: 4}),
    'ppt/media/second.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  }, filename => {
    const {status, report} = inspect(filename, {strict: true});
    assert.equal(status, 0);
    assert.equal(report.svgPictureCount, 2);
    assert.equal(report.validCount, 2);
    assert.equal(report.errorCount, 0);
    assert.deepEqual(report.pictures.map(p => [p.pictureName, p.fallbackPart]), [
      ['First SVG', 'ppt/media/valid fallback.png'], ['Second SVG', 'ppt/media/second.png'],
    ]);
  });
});

test('orphan slides and unused media are ignored while a used layout is inspected', async () => {
  await withFixture({
    'ppt/slides/slide2.xml': slide(picture('Unused SVG', null)),
    'ppt/slides/_rels/slide1.xml.rels': packageRels(rel('vector', '../media/vector.svg')
      + rel('raster', '../media/fallback.png') + rel('layout', '../slideLayouts/slideLayout1.xml', 'slideLayout')),
    'ppt/slideLayouts/slideLayout1.xml': slide(picture('Used layout SVG', 'layoutRaster')),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': packageRels(rel('vector', '../media/vector.svg') + rel('layoutRaster', '../media/layout.png')),
    'ppt/media/layout.png': png({alpha: 0}),
  }, filename => {
    const {report} = inspect(filename, {strict: true});
    assert.equal(report.svgPictureCount, 2);
    assert.equal(report.validCount, 1);
    assert.equal(report.pictures[1].part, 'ppt/slideLayouts/slideLayout1.xml');
    assert.ok(report.pictures[1].issues.some(i => i.code === 'transparent_fallback'));
  });
});

test('unsupported PNG encoding is explicitly unverified, never counted as valid', async () => {
  await withFixture({'ppt/media/fallback.png': png({depth: 16})}, filename => {
    const {status, report} = inspect(filename, {strict: true});
    assert.equal(status, 0, 'fail-on-error only fails for confirmed errors');
    assert.equal(report.validCount, 0);
    assert.equal(report.warningCount, 1);
    assert.equal(report.pictures[0].status, 'unverified');
    assert.equal(report.pictures[0].png.verified, false);
    assert.ok(!Object.hasOwn(report.pictures[0].png, 'fullyTransparent'));
  });
});

test('non-PNG encodings remain unverified and corrupted PNG data produces an error', async () => {
  const broken = png();
  broken[40] ^= 1;
  for (const [bytes, expected] of [[Buffer.from('unsupported raster encoding'), 'unverified'], [broken, 'error']]) {
    await withFixture({'ppt/media/fallback.png': bytes}, filename => {
      const {status, report} = inspect(filename, {strict: true});
      assert.equal(report.pictures[0].status, expected);
      assert.equal(report.validCount, 0);
      assert.equal(status, expected === 'error' ? 1 : 0);
    });
  }
});

test('a damaged one-pixel placeholder retains its header dimensions without claiming verified alpha', async () => {
  const broken = png({width: 1, height: 1, alpha: 0});
  broken[40] ^= 1;
  await withFixture({'ppt/media/fallback.png': broken}, filename => {
    const {status, report} = inspect(filename, {strict: true});
    const picture = report.pictures[0];
    assert.equal(status, 1);
    assert.equal(picture.png.width, 1);
    assert.equal(picture.png.height, 1);
    assert.equal(picture.png.verified, false);
    assert.ok(!Object.hasOwn(picture.png, 'fullyTransparent'));
    assert.deepEqual(picture.issues.map(i => i.code), ['one_pixel_fallback', 'invalid_fallback']);
  });
});

test('a used master is checked without traversing its unused layouts', async () => {
  await withFixture({
    'ppt/slides/_rels/slide1.xml.rels': packageRels(rel('vector', '../media/vector.svg')
      + rel('raster', '../media/fallback.png') + rel('layout', '../slideLayouts/slideLayout1.xml', 'slideLayout')),
    'ppt/slideLayouts/slideLayout1.xml': slide(''),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': packageRels(rel('master', '../slideMasters/slideMaster1.xml', 'slideMaster')),
    'ppt/slideMasters/slideMaster1.xml': slide(picture('Used master SVG', 'masterRaster')),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': packageRels(rel('vector', '../media/vector.svg')
      + rel('masterRaster', '../media/fallback.png') + rel('unusedLayout', '../slideLayouts/slideLayout2.xml', 'slideLayout')),
    'ppt/slideLayouts/slideLayout2.xml': slide(picture('Unused layout SVG', null)),
  }, filename => {
    const {status, report} = inspect(filename, {strict: true});
    assert.equal(status, 0);
    assert.equal(report.svgPictureCount, 2);
    assert.equal(report.validCount, 2);
    assert.equal(report.pictures[1].pictureName, 'Used master SVG');
  });
});

test('root inspector reports fallbacks by default and opts into a failing exit status', async () => {
  await withFixture({'ppt/media/fallback.png': png({width: 1, height: 1, alpha: 0})}, filename => {
    const normal = inspect(filename, {script: INSPECTOR});
    assert.equal(normal.status, 0);
    assert.equal(normal.data.slideCount, 1);
    assert.equal(normal.report.errorCount, 2);
    const strict = inspect(filename, {script: INSPECTOR, strict: true});
    assert.equal(strict.status, 1);
    assert.deepEqual(strict.report, normal.report);
  });
});
