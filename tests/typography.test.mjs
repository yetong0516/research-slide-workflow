import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import {applyScriptFonts} from '../src/typography.mjs';

const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk3sAAAAASUVORK5CYII=', 'base64');
const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

async function withDeck(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pptx-typography-'));
  try {await callback(path.join(dir, 'mixed.pptx'));}
  finally {await fs.rm(dir, {recursive: true, force: true});}
}

async function fixture(filename, files) {
  const zip = new JSZip();zip.file('[Content_Types].xml', contentTypes);
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  await fs.writeFile(filename, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
}

async function partsOf(filename) {
  const zip = await JSZip.loadAsync(await fs.readFile(filename)), parts = new Map();
  for (const file of Object.values(zip.files).filter(file => !file.dir)) parts.set(file.name, await file.async('nodebuffer'));
  return parts;
}

function assertScriptSlots(xml) {
  const properties = [...xml.matchAll(/<a:(rPr|defRPr|endParaRPr)\b[^>]*>([\s\S]*?)<\/a:\1>/g)];
  for (const [, name, contents] of properties) {
    assert.equal((contents.match(/<a:latin\b/g) ?? []).length, 1, `${name} has one Latin slot`);
    assert.equal((contents.match(/<a:ea\b/g) ?? []).length, 1, `${name} has one East Asian slot`);
    assert.match(contents, /<a:latin\b[^>]*typeface="Arial"/);
    assert.match(contents, /<a:ea\b[^>]*typeface="微软雅黑"/);
    assert.ok(contents.indexOf('<a:latin') < contents.indexOf('<a:ea'));
  }
  assert.doesNotMatch(xml, /<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\/>/, 'self-closing properties acquire script slots');
  return properties.length;
}

test('real mixed text and native chart acquire script fonts without changing text, numbers, media or workbook bytes', async () => {
  await withDeck(async filename => {
    const pptx = new PptxGenJS();pptx.layout = 'LAYOUT_WIDE';
    pptx.theme = {headFontFace: 'Arial Unicode MS', bodyFontFace: 'Tahoma', lang: 'zh-CN'};
    const slide = pptx.addSlide();
    slide.addText([{text: '中文结果 Results 95% CI α', options: {fontFace: 'Arial Unicode MS'}},
      {text: '\n随访 Follow-up 28天', options: {fontFace: 'Times New Roman'}}],
    {x: 0.7, y: 0.4, w: 8.1, h: 0.8, fontSize: 24, bold: true});
    slide.addChart(pptx.ChartType.bar, [{name: '候选 Series', labels: ['中文 Control', 'Treatment A'], values: [2.5, 3.25]}],
      {x: 1, y: 1.6, w: 8, h: 4, showLegend: true, showValue: true,
        showTitle: true, title: '图表 Chart', titleFontFace: 'Calibri',
        catAxisLabelFontFace: 'Arial Unicode MS', valAxisLabelFontFace: 'Times New Roman'});
    slide.addImage({data: `image/png;base64,${PNG.toString('base64')}`, x: 10, y: 1, w: 1, h: 1});
    slide.addNotes('备注 Notes：数据为字体契约测试，2.5 和 3.25 必须保持。');
    await pptx.writeFile({fileName: filename, compression: true});
    const before = await partsOf(filename), result = await applyScriptFonts(filename), after = await partsOf(filename);
    assert.equal(result.changed, true);
    assert.ok(result.updatedParts.includes('ppt/slides/slide1.xml'));
    assert.ok(result.updatedParts.includes('ppt/charts/chart1.xml'));
    assert.ok(result.updatedParts.includes('ppt/notesSlides/notesSlide1.xml'));
    assert.ok(result.updatedParts.some(name => /^ppt\/theme\//.test(name)));
    assert.deepEqual([...after.keys()], [...before.keys()]);
    let nativeTextProperties = 0, media = 0, workbooks = 0;
    for (const [name, original] of before) {
      const revised = after.get(name);
      if (!result.updatedParts.includes(name)) assert.deepEqual(revised, original, `${name} stays byte-identical`);
      else {
        const originalXml = original.toString(), revisedXml = revised.toString();
        nativeTextProperties += assertScriptSlots(revisedXml);
        for (const pattern of [/<a:t\b[^>]*>[\s\S]*?<\/a:t>/g, /<c:(?:f|v)\b[^>]*>[\s\S]*?<\/c:(?:f|v)>/g,
          /<a:(?:off|ext|chOff|chExt)\b[^>]*\/>/g]) {
          assert.deepEqual(revisedXml.match(pattern), originalXml.match(pattern), `${name} retains text/data/geometry`);
        }
      }
      if (name.startsWith('ppt/media/')) {media++;assert.deepEqual(revised, original);}
      if (name.startsWith('ppt/embeddings/')) {workbooks++;assert.deepEqual(revised, original);}
    }
    assert.ok(nativeTextProperties > 10);assert.ok(media > 0);assert.ok(workbooks > 0);
    const theme = after.get('ppt/theme/theme1.xml').toString();
    for (const [, content] of theme.matchAll(/<a:(?:majorFont|minorFont)>([\s\S]*?)<\/a:(?:majorFont|minorFont)>/g)) {
      assert.match(content, /<a:latin typeface="Arial"/);assert.match(content, /<a:ea typeface="微软雅黑"/);
    }
    const appliedBytes = await fs.readFile(filename), repeated = await applyScriptFonts(filename);
    assert.equal(repeated.changed, false);assert.equal(repeated.updatedProperties, 0);
    assert.deepEqual(await fs.readFile(filename), appliedBytes, 'second application does not rewrite the package');
  });
});

test('self-closing properties and missing slots preserve DrawingML order and symbol/complex-script choices', async () => {
  await withDeck(async filename => {
    const xml = `<root xmlns:a="${DRAWING}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + '<a:rPr sz="2400"/><a:defRPr b="1"><a:solidFill><a:srgbClr val="123456"/></a:solidFill>'
      + '<a:ea typeface="宋体"/><a:cs typeface="Traditional Arabic"/><a:sym typeface="Wingdings"/>'
      + '<a:hlinkClick r:id="rId7"/></a:defRPr><a:endParaRPr><a:latin typeface="Calibri"/></a:endParaRPr>'
      + '<a:buFont typeface="Wingdings 2"/></root>';
    await fixture(filename, {'ppt/slides/slide1.xml': xml});
    await applyScriptFonts(filename);
    const actual = (await partsOf(filename)).get('ppt/slides/slide1.xml').toString();
    assert.equal(actual, xml.replace('<a:rPr sz="2400"/>', '<a:rPr sz="2400"><a:latin typeface="Arial"/><a:ea typeface="微软雅黑"/></a:rPr>')
      .replace('<a:ea typeface="宋体"/>', '<a:latin typeface="Arial"/><a:ea typeface="微软雅黑"/>')
      .replace('<a:latin typeface="Calibri"/>', '<a:latin typeface="Arial"/><a:ea typeface="微软雅黑"/>'));
    assert.match(actual, /<a:cs typeface="Traditional Arabic"\/>/);
    assert.match(actual, /<a:sym typeface="Wingdings"\/>/);
    assert.match(actual, /<a:buFont typeface="Wingdings 2"\/>/);
    assertScriptSlots(actual);
  });
});

test('masters, layouts, notes and presentation styles are covered without altering media XML or relationships', async () => {
  await withDeck(async filename => {
    const text = `<root xmlns:a="${DRAWING}"><a:defRPr/></root>`;
    const files = Object.fromEntries(['ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml', 'ppt/notesMasters/notesMaster1.xml',
      'ppt/notesSlides/notesSlide1.xml', 'ppt/handoutMasters/handoutMaster1.xml'].map(name => [name, text]));
    files['ppt/media/figure.xml'] = text;files['ppt/embeddings/workbook.xml'] = text;
    files['ppt/slides/_rels/slide1.xml.rels'] = '<Relationships><Relationship Id="rId1" Target="../media/figure.xml"/></Relationships>';
    await fixture(filename, files);const before = await partsOf(filename);
    const result = await applyScriptFonts(filename), after = await partsOf(filename);
    assert.equal(result.updatedParts.length, 6);
    for (const name of result.updatedParts) assertScriptSlots(after.get(name).toString());
    for (const name of ['ppt/media/figure.xml', 'ppt/embeddings/workbook.xml', 'ppt/slides/_rels/slide1.xml.rels']) {
      assert.deepEqual(after.get(name), before.get(name));
    }
  });
});

test('namespace aliases, default namespace and opaque XML regions are respected', async () => {
  await withDeck(async filename => {
    const xml = `<root xmlns:q="${DRAWING}" xmlns:a="urn:unrelated">`
      + '<!-- <q:rPr><q:latin typeface="Comment"/></q:rPr> -->'
      + '<![CDATA[<q:rPr><q:latin typeface="CDATA"/></q:rPr>]]>'
      + '<q:rPr data-label="A > B"><q:ea typeface=\'旧字体\'/><q:cs typeface="Symbol"/></q:rPr>'
      + '<a:rPr><a:latin typeface="Unrelated"/></a:rPr>'
      + `<group xmlns="${DRAWING}"><defRPr/></group></root>`;
    await fixture(filename, {'ppt/charts/chart1.xml': xml});await applyScriptFonts(filename);
    const actual = (await partsOf(filename)).get('ppt/charts/chart1.xml').toString();
    assert.equal(actual, xml.replace("<q:ea typeface='旧字体'/>", '<q:latin typeface="Arial"/><q:ea typeface=\'微软雅黑\'/>')
      .replace('<defRPr/>', '<defRPr><latin typeface="Arial"/><ea typeface="微软雅黑"/></defRPr>'));
  });
});

test('theme collections update Chinese supplemental mapping while preserving other scripts', async () => {
  await withDeck(async filename => {
    const xml = `<a:theme xmlns:a="${DRAWING}"><a:fontScheme name="Office">`
      + '<a:majorFont><a:latin typeface="Calibri"/><a:cs typeface="Arabic Font"/>'
      + '<a:font script="Hans" typeface="宋体"/><a:font script="Hant" typeface="新細明體"/>'
      + '<a:font script="Jpan" typeface="Yu Gothic"/></a:majorFont><a:minorFont/></a:fontScheme></a:theme>';
    await fixture(filename, {'ppt/theme/theme1.xml': xml});await applyScriptFonts(filename);
    const actual = (await partsOf(filename)).get('ppt/theme/theme1.xml').toString();
    assert.match(actual, /<a:majorFont><a:latin typeface="Arial"\/><a:ea typeface="微软雅黑"\/><a:cs typeface="Arabic Font"\/>/);
    assert.match(actual, /<a:minorFont><a:latin typeface="Arial"\/><a:ea typeface="微软雅黑"\/><a:cs typeface=""\/><\/a:minorFont>/);
    assert.match(actual, /script="Hans" typeface="微软雅黑"/);assert.match(actual, /script="Hant" typeface="微软雅黑"/);
    assert.match(actual, /script="Jpan" typeface="Yu Gothic"/);
  });
});

test('custom font families are XML-escaped and apply to runs without existing properties', async () => {
  await withDeck(async filename => {
    const xml = `<a:txBody xmlns:a="${DRAWING}"><a:p><a:r><a:t>中文 Mixed 42</a:t></a:r>`
      + '<a:fld id="field-1"><a:pPr/><a:t>Field 7</a:t></a:fld><a:br/></a:p></a:txBody>';
    await fixture(filename, {'ppt/slides/slide1.xml': xml});
    const result = await applyScriptFonts(filename, {eastAsian: '思源黑体 & "UI"', latin: "Arial <Custom>"});
    const actual = (await partsOf(filename)).get('ppt/slides/slide1.xml').toString();
    assert.equal(result.eastAsian, '思源黑体 & "UI"');
    assert.equal((actual.match(/typeface="思源黑体 &amp; &quot;UI&quot;"/g) ?? []).length, 3);
    assert.equal((actual.match(/typeface="Arial &lt;Custom&gt;"/g) ?? []).length, 3);
    assert.match(actual, /<a:fld id="field-1"><a:rPr>[\s\S]*?<\/a:rPr><a:pPr\/>/);
    assert.deepEqual(actual.match(/<a:t>[\s\S]*?<\/a:t>/g), xml.match(/<a:t>[\s\S]*?<\/a:t>/g));
    const before = await fs.readFile(filename);
    assert.equal((await applyScriptFonts(filename, {eastAsian: '思源黑体 & "UI"', latin: "Arial <Custom>"})).changed, false);
    assert.deepEqual(await fs.readFile(filename), before);
  });
});

test('invalid XML, duplicate slots and invalid font names fail without replacing the package', async () => {
  await withDeck(async filename => {
    for (const body of ['<a:rPr>', '<a:rPr><a:latin/><a:latin/></a:rPr>']) {
      await fixture(filename, {'ppt/slides/slide1.xml': `<root xmlns:a="${DRAWING}">${body}</root>`});
      const before = await fs.readFile(filename);
      await assert.rejects(applyScriptFonts(filename), /Invalid XML structure|Duplicate latin/);
      assert.deepEqual(await fs.readFile(filename), before);
    }
    await fixture(filename, {'ppt/slides/slide1.xml': `<root xmlns:a="${DRAWING}"><a:rPr/></root>`});
    const before = await fs.readFile(filename);
    for (const invalid of ['', 'A\u0000B', '\ud800']) {
      await assert.rejects(applyScriptFonts(filename, {eastAsian: invalid}), /font family/);
      assert.deepEqual(await fs.readFile(filename), before);
    }
  });
});
