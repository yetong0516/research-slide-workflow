import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { renderPresentation } from '../src/render.mjs';

// Read the saved OOXML using Node's ZIP primitives, without an Office installation.
function zipEntries(buffer) {
  let end = buffer.length-22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'PPTX has a ZIP directory');
  const result = new Map();
  let cursor = buffer.readUInt32LE(end+16);
  for (let i = 0; i < buffer.readUInt16LE(end+10); i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor+10), size = buffer.readUInt32LE(cursor+20);
    const nameLength = buffer.readUInt16LE(cursor+28);
    const name = buffer.subarray(cursor+46, cursor+46+nameLength).toString();
    const local = buffer.readUInt32LE(cursor+42);
    const start = local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);
    const data = buffer.subarray(start, start+size);
    result.set(name, method === 8 ? inflateRawSync(data).toString() : data.toString());
    cursor += 46+nameLength+buffer.readUInt16LE(cursor+30)+buffer.readUInt16LE(cursor+32);
  }
  return result;
}

function card(id, direction = 'horizontal', count = 3) {
  const nodes = Array.from({length: count}, (_, i) => ({id: `${id}-node-${i}`, label: `拟议节点${i+1}`}));
  return {id, heading: `任务${id}`, caption: '拟比较预先定义的信息与结局',
    statementType: 'proposed', deliverable: '预先定义的分析方案',
    visual: {type: 'diagram', role: 'design', direction, nodes,
      edges: nodes.slice(1).map((node, i) => ({from: nodes[i].id, to: node.id}))}};
}

function proposal() {
  return {schemaVersion: 1, template: 'proposal', title: '完整研究题目保留在备注中',
    topic: '公开资料与预先定义结局的拟议关联评价', language: 'zh', references: [], slides: [
      {id: 'background', kind: 'background', layout: 'chain', title: '较长背景内容标题',
        cards: Array.from({length: 4}, (_, i) => card(`b${i}`, 'vertical'))},
      {id: 'question', kind: 'question', layout: 'question', title: '较长科学问题标题',
        mainQuestion: '候选信息能否回答预先定义的研究问题？',
        cards: Array.from({length: 3}, (_, i) => card(`q${i}`))},
      ...Array.from({length: 3}, (_, i) => ({id: `research-${i}`, kind: 'research', layout: 'split',
        title: `较长研究内容标题${i}`, cards: [card(`r${i}a`), card(`r${i}b`, 'vertical', 5)]})),
      {id: 'plan', kind: 'plan', layout: 'roadmap', title: '较长研究计划标题',
        cards: Array.from({length: 4}, (_, i) => card(`p${i}`, 'vertical'))},
      {id: 'references', kind: 'references', title: '参考文献'},
    ]};
}

test('proposal deck saves native diagrams, chapter headers and complete notes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proposal-render-'));
  try {
    const spec = proposal();
    // Exercise a nonadjacent route as well as the ordinary chain connectors.
    const visual = spec.slides[2].cards[0].visual;
    visual.edges.push({from: visual.nodes[0].id, to: visual.nodes[2].id});
    const output = await renderPresentation(spec, {baseDir: dir, outputPath: path.join(dir, 'deck.pptx')});
    assert.equal(output.slideCount, 7);
    assert.deepEqual(output.warnings, []);
    const entries = zipEntries(await fs.readFile(output.outputPath));
    const slides = [...entries].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(slides.length, 7);
    assert.equal([...entries.keys()].filter(name => /^ppt\/media\/.+[^/]$/.test(name)).length, 0);
    const background = entries.get('ppt/slides/slide1.xml');
    for (const stage of ['研究背景', '问题', '现状', '对策', '目标']) assert.ok(background.includes(stage));
    assert.ok(!background.includes('较长背景内容标题'));
    const question = entries.get('ppt/slides/slide2.xml');
    assert.ok(question.includes(spec.slides[1].mainQuestion));
    assert.ok(question.includes('科学问题'));
    for (let i = 1; i <= 6; i++) {
      const xml = entries.get(`ppt/slides/slide${i}.xml`);
      assert.match(xml, /prst="roundRect"/, `slide ${i} contains editable node shapes`);
      assert.match(xml, /End type="triangle"/, `slide ${i} contains native arrowheads`);
      assert.match(xml, /<a:t>拟议节点1<\/a:t>/, `slide ${i} contains editable node text`);
      assert.ok(!xml.includes('<p:pic>'), `slide ${i} is not flattened to a picture`);
      const notes = entries.get(`ppt/notesSlides/notesSlide${i}.xml`);
      assert.ok(notes.includes(spec.topic));
      assert.ok(notes.includes(spec.slides[i-1].title));
    }
    const research = entries.get('ppt/slides/slide3.xml');
    assert.ok(research.includes('交付：预先定义的分析方案'));
    assert.ok(research.includes('拟议研究设计示意'));
    // Diagram labels are explicitly 12–16 pt rather than rasterized annotations.
    assert.match(research, /sz="(?:1200|1400|1600)"/);
    assert.match(research, /sz="1800"/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('default compact demo still uses its original five-page renderer with real charts and separate images', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-render-'));
  try {
    const baseDir = path.resolve('examples/demo');
    const spec = JSON.parse(await fs.readFile(path.join(baseDir, 'spec.json'), 'utf8'));
    spec.slides[0].cards[0].visual.footnote = '原始数据的解释条件';
    spec.references[0].claims[0].visual.footnote = '原始数据的解释条件';
    const output = await renderPresentation(spec, {baseDir, outputPath: path.join(dir, 'deck.pptx')});
    assert.equal(output.slideCount, 5);
    const entries = zipEntries(await fs.readFile(output.outputPath));
    assert.ok(entries.get('ppt/slides/slide1.xml').includes(spec.slides[0].title));
    assert.ok(entries.get('ppt/slides/slide1.xml').includes('原始数据的解释条件'));
    assert.ok([...entries.keys()].some(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)));
    assert.ok([...entries.keys()].some(name => /^ppt\/media\/.+[^/]$/.test(name)));
    assert.match(entries.get('ppt/slides/slide2.xml'), /<p:pic>/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
