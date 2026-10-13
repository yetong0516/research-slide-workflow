import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import {repairMasterContentTypes, normaliseSingleLevelChartCategories} from '../src/pptx-package.mjs';

const MASTER_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const override = (name, type = MASTER_TYPE) => `<Override PartName="/${name}" ContentType="${type}"/>`;
const contentTypes = inner => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${inner}</Types>`;
const relationships = inner => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;

async function withFixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pptx-package-'));
  try { await fn(path.join(dir, 'deck.pptx')); }
  finally { await fs.rm(dir, {recursive: true, force: true}); }
}

async function saveFixture(filename, entries) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(entries)) zip.file(name, data);
  await fs.writeFile(filename, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
}

test('real seven-slide PptxGenJS package removes six dangling masters and preserves every other part', async () => {
  await withFixture(async filename => {
    const pptx = new PptxGenJS();
    for (let i = 1; i <= 7; i++) pptx.addSlide().addText(`Editable slide ${i}`, {x: 1, y: 1, w: 7, h: 1, fontSize: 24});
    await pptx.writeFile({fileName: filename, compression: true});
    const before = await JSZip.loadAsync(await fs.readFile(filename));
    const result = await repairMasterContentTypes(filename);
    assert.equal(result.repaired, true);
    assert.equal(result.removedOverrides.length, 6);
    const after = await JSZip.loadAsync(await fs.readFile(filename));
    const types = await after.file('[Content_Types].xml').async('string');
    assert.ok(types.includes('/ppt/slideMasters/slideMaster1.xml'));
    assert.ok(!types.includes('/ppt/slideMasters/slideMaster2.xml'));
    assert.deepEqual(Object.keys(after.files), Object.keys(before.files));
    for (const [name, file] of Object.entries(before.files)) {
      if (name === '[Content_Types].xml' || file.dir) continue;
      assert.deepEqual(await after.file(name).async('nodebuffer'), await file.async('nodebuffer'), name);
    }
    const repairedBytes = await fs.readFile(filename);
    assert.deepEqual(await repairMasterContentTypes(filename), {removedOverrides: [], repaired: false});
    assert.deepEqual(await fs.readFile(filename), repairedBytes, 'idempotent calls do not rewrite a valid package');
  });
});

test('unreferenced absent master is removed while real masters and other missing content types remain', async () => {
  await withFixture(async filename => {
    await saveFixture(filename, {
      '[Content_Types].xml': contentTypes(override('ppt/slideMasters/slideMaster1.xml')
        +override('ppt/slideMasters/slideMaster2.xml')
        +override('ppt/slides/slide404.xml', 'missing-slide-type')
        +override('ppt/charts/chart404.xml', 'missing-chart-type')),
      'ppt/slideMasters/slideMaster1.xml': '<real-master/>',
      'ppt/slides/_rels/slide1.xml.rels': relationships('<Relationship Id="missing-chart" Target="../charts/chart404.xml" Type="chart"/>'),
      'custom/data.bin': Buffer.from([0, 1, 255, 17]),
    });
    assert.deepEqual((await repairMasterContentTypes(filename)).removedOverrides, ['/ppt/slideMasters/slideMaster2.xml']);
    const repaired = await JSZip.loadAsync(await fs.readFile(filename));
    const types = await repaired.file('[Content_Types].xml').async('string');
    assert.ok(types.includes('slideMaster1.xml'));
    assert.ok(types.includes('slide404.xml'));
    assert.ok(types.includes('chart404.xml'));
    assert.deepEqual(await repaired.file('custom/data.bin').async('nodebuffer'), Buffer.from([0, 1, 255, 17]));
    assert.ok((await repaired.file('ppt/slides/_rels/slide1.xml.rels').async('string')).includes('chart404.xml'));
  });
});

test('a missing master referenced through a relative internal relationship fails without modifying the file', async () => {
  await withFixture(async filename => {
    await saveFixture(filename, {
      '[Content_Types].xml': contentTypes(override('ppt/slideMasters/slideMaster2.xml')),
      'ppt/slides/_rels/slide1.xml.rels': relationships("<Relationship Id='master' Target='../slideMasters/slideMaster&#50;.xml' Type='master'/>")
    });
    const before = await fs.readFile(filename);
    await assert.rejects(repairMasterContentTypes(filename), /Referenced slide master is missing: \/ppt\/slideMasters\/slideMaster2\.xml/);
    assert.deepEqual(await fs.readFile(filename), before);
  });
});

test('XML comments and external relationships do not count as internal references', async () => {
  await withFixture(async filename => {
    await saveFixture(filename, {
      '[Content_Types].xml': contentTypes(override('ppt/slideMasters/slideMaster2.xml')
        +'<!-- '+override('ppt/slideMasters/slideMaster3.xml')+' -->'),
      'ppt/_rels/presentation.xml.rels': relationships('<Relationship Id="external" Target="/ppt/slideMasters/slideMaster2.xml" TargetMode="External" Type="master"/>'
        +'<!-- <Relationship Id="comment" Target="slideMasters/slideMaster2.xml"/> -->'),
    });
    assert.deepEqual((await repairMasterContentTypes(filename)).removedOverrides, ['/ppt/slideMasters/slideMaster2.xml']);
    const zip = await JSZip.loadAsync(await fs.readFile(filename));
    assert.ok((await zip.file('[Content_Types].xml').async('string')).includes('<!-- '+override('ppt/slideMasters/slideMaster3.xml')+' -->'));
  });
});

test('empty paired Override elements are removed as complete XML elements', async () => {
  await withFixture(async filename => {
    await saveFixture(filename, {
      '[Content_Types].xml': contentTypes(override('ppt/slideMasters/slideMaster2.xml').replace('/>', '> \n </Override>')),
    });
    assert.equal((await repairMasterContentTypes(filename)).removedOverrides.length, 1);
    const zip = await JSZip.loadAsync(await fs.readFile(filename));
    const types = await zip.file('[Content_Types].xml').async('string');
    assert.ok(!types.includes('Override'));
    assert.ok(types.endsWith('</Types>'));
  });
});

test('real seven-page demo chart categories become flat refs while labels, formulas, values and workbooks stay unchanged', async () => {
  await withFixture(async filename => {
    const demo = JSON.parse(await fs.readFile('examples/proposal/spec.json', 'utf8'));
    const visuals = demo.slides.flatMap(slide => slide.cards ?? []).map(card => card.visual).filter(visual => visual.type === 'bar');
    const pptx = new PptxGenJS();
    for (let i = 0; i < 7; i++) {
      const slide = pptx.addSlide();
      slide.addText(demo.slides[i].title, {x: 1, y: 0.3, w: 9, h: 0.8, fontSize: 24});
      if (visuals[i]) slide.addChart(pptx.ChartType.bar,
        visuals[i].series.map(series => ({name: series.name, labels: visuals[i].categories, values: series.values})),
        {x: 1, y: 1.5, w: 8, h: 4, barDir: 'col'});
    }
    await pptx.writeFile({fileName: filename, compression: true});
    const before = await JSZip.loadAsync(await fs.readFile(filename));
    const result = await normaliseSingleLevelChartCategories(filename);
    assert.equal(result.normalisedCharts.length, visuals.length);
    assert.equal(result.normalisedCategories, visuals.reduce((sum, visual) => sum+visual.series.length, 0));
    const after = await JSZip.loadAsync(await fs.readFile(filename));
    assert.deepEqual(Object.keys(after.files), Object.keys(before.files));
    for (const [name, part] of Object.entries(before.files)) {
      if (part.dir) continue;
      if (!result.normalisedCharts.includes(name)) {
        assert.deepEqual(await after.file(name).async('nodebuffer'), await part.async('nodebuffer'), name);
      } else {
        const original = await part.async('string'), revised = await after.file(name).async('string');
        assert.deepEqual(revised.match(/<c:val>[\s\S]*?<\/c:val>/g), original.match(/<c:val>[\s\S]*?<\/c:val>/g));
        assert.equal(revised, original.replace(/c:multiLvlStrRef/g, 'c:strRef')
          .replace(/c:multiLvlStrCache/g, 'c:strCache').replace(/<\/?c:lvl>/g, ''));
      }
    }
    const bytes = await fs.readFile(filename);
    assert.equal((await normaliseSingleLevelChartCategories(filename)).repaired, false);
    assert.deepEqual(await fs.readFile(filename), bytes);
  });
});

const categoryChart = (count, levels) => `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:cat><c:multiLvlStrRef><c:f>Sheet1!$A$2:$A$3</c:f><c:multiLvlStrCache><c:ptCount val="${count}"/>${levels}</c:multiLvlStrCache></c:multiLvlStrRef></c:cat></c:chartSpace>`;
const level = '<c:lvl><c:pt idx="0"><c:v>A &amp; B</c:v></c:pt><c:pt idx="1"><c:v>临床标签</c:v></c:pt></c:lvl>';

test('genuine two-level chart categories remain byte-for-byte unchanged', async () => {
  await withFixture(async filename => {
    await saveFixture(filename, {'ppt/charts/chart1.xml': categoryChart(2, level+level)});
    const bytes = await fs.readFile(filename);
    assert.deepEqual(await normaliseSingleLevelChartCategories(filename), {
      normalisedCharts: [], normalisedCategories: 0, repaired: false});
    assert.deepEqual(await fs.readFile(filename), bytes);
  });
});

test('malformed single-level category count or indexes fail without rewriting the package', async () => {
  await withFixture(async filename => {
    for (const xml of [categoryChart(3, level), categoryChart(2, level.replace('idx="1"', 'idx="0"')),
      categoryChart('unknown', level), categoryChart(2, level.replace('<c:v>临床标签</c:v>', ''))]) {
      await saveFixture(filename, {'ppt/charts/chart1.xml': xml});
      const bytes = await fs.readFile(filename);
      await assert.rejects(normaliseSingleLevelChartCategories(filename), /Invalid single-level chart category cache/);
      assert.deepEqual(await fs.readFile(filename), bytes);
    }
  });
});
