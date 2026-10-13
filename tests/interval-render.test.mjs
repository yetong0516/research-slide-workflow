import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { renderPresentation } from '../src/render.mjs';

// Synthetic contract fixture, with no claim that these numbers are research evidence.
function intervalFixture(values) {
  const visual = {
    type: 'interval', dataChecked: true, categories: ['<65岁', '65–74岁', '≥75岁'],
    series: [{name: '合成测试区间', lower: [1, 13.3, 51.3], upper: [5.1, 27.8, 99.4],
      ...(values ? {values} : {})}],
    unit: '例/10万人/年', intervalLabel: '95%CrI', sourceIds: ['synthetic-source'],
    locator: 'Synthetic Table 1, age-group rows', statistic: 'synthetic interval endpoints',
    footnote: '仅展示区间上下界', axis: {min: 0, max: 110, majorUnit: 50, title: '合成测试数据'},
  };
  const claim = {id: 'synthetic-interval', type: 'numerical', status: 'checked', reviewed: true,
    reviewer: 'Test fixture', reviewNote: 'Contract test data only', locator: visual.locator,
    sourceIds: visual.sourceIds, heading: '合成区间测试', text: '合成数据仅用于验证渲染行为',
    visual: structuredClone(visual)};
  const evidenceCard = {id: 'interval-card', heading: claim.heading, caption: claim.text,
    statementType: 'evidence', evidence: {status: 'checked', sourceIds: visual.sourceIds,
      claimIds: [claim.id], locator: claim.locator}, visual};
  const proposed = id => ({id, heading: '测试占位', caption: '', statementType: 'proposed',
    visual: {type: 'placeholder', role: 'design', label: '测试占位'}});
  return {schemaVersion: 1, template: 'compact', title: '区间图契约测试', language: 'zh',
    references: [{id: 'synthetic-source', title: 'Synthetic interval contract fixture', year: 2026,
      url: 'https://example.org/synthetic-interval', claims: [claim]}],
    slides: [
      {id: 'background', kind: 'background', title: '区间展示',
        cards: [evidenceCard, ...Array.from({length: 3}, (_, i) => proposed(`b-${i}`))]},
      {id: 'research', kind: 'research', title: '渲染测试',
        cards: Array.from({length: 4}, (_, i) => proposed(`r-${i}`))},
      {id: 'plan', kind: 'plan', title: '验证计划',
        cards: Array.from({length: 4}, (_, i) => proposed(`p-${i}`))},
      {id: 'references', kind: 'references', title: '参考文献'},
    ]};
}

const decodeXml = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&').replaceAll('\r\n', '\n');
const textIn = xml => [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
  .map(match => decodeXml(match[1])).join('\n');
function shapeGeometry(xml, objectName) {
  const shape = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
    .find(match => match[0].includes(`name="${objectName}"`))?.[0];
  assert.ok(shape, `native shape ${objectName} exists`);
  const offset = shape.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
  const extent = shape.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(offset && extent, `native shape ${objectName} has editable geometry`);
  return {x: Number(offset[1]), y: Number(offset[2]), w: Number(extent[1]), h: Number(extent[2])};
}

async function withDeck(spec, inspect) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interval-render-'));
  try {
    const output = await renderPresentation(spec, {baseDir: dir, outputPath: path.join(dir, 'deck.pptx')});
    const zip = await JSZip.loadAsync(await fs.readFile(output.outputPath));
    await inspect(zip, await zip.file('ppt/slides/slide1.xml').async('string'),
      await zip.file('ppt/notesSlides/notesSlide1.xml').async('string'));
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

test('reported intervals save as editable native endpoints with no invented point estimates', async () => {
  const spec = intervalFixture();
  const visual = spec.slides[0].cards[0].visual;
  await withDeck(spec, async (zip, xml, notes) => {
    assert.ok(!Object.keys(zip.files).some(name => /^ppt\/media\/.+[^/]$/.test(name)));
    assert.ok(!xml.includes('<p:pic>'), 'data is not flattened into an image');
    assert.ok(!xml.includes('reported-point'), 'there is no point when no estimate was reported');
    assert.ok(!xml.includes('prst="ellipse"'), 'there is no synthetic midpoint glyph');
    const text = textIn(xml);
    for (const label of ['<65岁', '65–74岁', '≥75岁', '1–5.1', '13.3–27.8', '51.3–99.4',
      '95%CrI (例/10万人/年)']) {
      assert.ok(text.includes(label), `editable label ${label} is present`);
    }
    assert.match(xml, /sz="1200"/, 'category labels are 12 pt');
    assert.match(xml, /sz="1100"/, 'interval labels are 11 pt');
    const axis = shapeGeometry(xml, 'interval-axis');
    for (let i = 0; i < visual.categories.length; i++) {
      const name = `interval-series-0-category-${i}`;
      const segment = shapeGeometry(xml, `${name}-segment`);
      for (const endpoint of ['lower', 'upper']) {
        const shape = shapeGeometry(xml, `${name}-${endpoint}`);
        const expected = axis.x+visual.series[0][endpoint][i]/110*axis.w;
        assert.ok(Math.abs(shape.x-expected) <= 2, `${endpoint} endpoint uses its exact reported value`);
        assert.equal(shape.w, 0, 'the endpoint is a native vertical cap');
      }
      const lower = shapeGeometry(xml, `${name}-lower`);
      const upper = shapeGeometry(xml, `${name}-upper`);
      assert.equal(segment.x, lower.x);
      assert.ok(Math.abs(segment.x+segment.w-upper.x) <= 1);
      assert.equal(segment.h, 0, 'interval is horizontal');
      assert.equal(lower.y, upper.y);
    }
    const noteText = textIn(notes);
    assert.ok(!text.includes('仅展示区间上下界'));
    assert.ok(noteText.includes('仅展示区间上下界'));
    for (const field of ['dataChecked', 'sourceIds', 'locator', 'statistic', 'footnote', 'intervalLabel',
      'lower', 'upper', '例/10万人/年', 'Synthetic Table 1, age-group rows']) {
      assert.ok(noteText.includes(field), `notes preserve ${field}`);
    }
    assert.ok(!noteText.includes('"values"'), 'notes retain absence of a reported point');
    assert.ok(noteText.includes(JSON.stringify(visual, null, 2)), 'notes preserve the complete interval data');
  });
});

test('optional reported point estimates are plotted at their actual values', async () => {
  const values = [2, 18, 67];
  await withDeck(intervalFixture(values), async (_zip, xml, notes) => {
    const axis = shapeGeometry(xml, 'interval-axis');
    for (let i = 0; i < values.length; i++) {
      const point = shapeGeometry(xml, `interval-series-0-category-${i}-reported-point`);
      assert.ok(Math.abs(point.x+point.w/2-(axis.x+values[i]/110*axis.w)) <= 2,
        'point glyph uses the reported estimate, not an interval midpoint');
    }
    for (const label of ['2 (1–5.1)', '18 (13.3–27.8)', '67 (51.3–99.4)']) {
      assert.ok(textIn(xml).includes(label), 'reported point and interval are both readable native text');
    }
    assert.ok(textIn(notes).includes('"values"'), 'notes preserve the supplied estimates');
  });
});
