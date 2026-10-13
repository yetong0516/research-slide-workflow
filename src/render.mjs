import fs from 'node:fs/promises';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { validateSpec } from './schema.mjs';
import {repairMasterContentTypes,normaliseSingleLevelChartCategories} from './pptx-package.mjs';

const DEFAULT_COLORS = {
  green: '075238', teal: '1A9C96', mint: '68B58B', blue: '467EAC',
  gold: 'D9A13B', text: '234137', muted: '65776E', line: 'CBDBD2', bg: 'F7F9F6', white: 'FFFFFF',
};
const S = { width: 13.333333, height: 7.5, left: 0.4, gap: 0.14, cardWidth: 3.028333 };

const cleanHex = x => typeof x === 'string' && /^#?[\da-f]{6}$/i.test(x)
  ? x.replace(/^#/, '') : undefined;
const locale = language => language === 'en' ? {
  proposed: 'Proposed design', pending: 'Evidence pending', evidence: 'Published evidence', design: 'Design schematic',
  ai: 'AI design schematic', source: 'Source figure', chart: 'Redrawn from checked data',
  placeholder: 'Figure needed', footer: 'Research and plans are proposed; no project results are claimed.',
  referenceFooter: 'Numbers are from cited public sources. Design images are illustrative and replaceable.',
  proposalReferenceFooter: 'Numbers and claims are from the cited sources; schematics describe proposed research designs.',
} : {
  proposed: '拟议设计', pending: '证据待核实', evidence: '公开文献证据', design: '设计示意',
  ai: 'AI设计示意', source: '文献原图', chart: '据文献数据重绘',
  placeholder: '需配图', footer: '研究与计划为拟议设计，未声称已取得项目结果。',
  referenceFooter: '数字据所列公开来源；AI设计图为独立可替换的示意图片。',
  proposalReferenceFooter: '数字与结论据所列来源；科研设计示意为拟议方案。',
};

function addText(slide, value, rect, context, size = 16, extras = {}) {
  slide.addText(String(value ?? ''), {
    ...rect, fontFace: context.font, fontSize: size, color: context.colors.text,
    breakLine: false, margin: 0, valign: 'mid', paraSpaceAfterPt: 0,
    fit: 'shrink', ...extras,
  });
}

function header(slide, spec, slideSpec, context, page) {
  const C = context.colors;
  slide.background = { color: C.bg };
  addText(slide, slideSpec.title, { x: 0.4, y: 0.23, w: 12.45, h: 0.52 }, context, 28,
    { bold: true, color: C.green });
  addText(slide, slideSpec.subtitle ?? spec.subtitle ?? '',
    { x: 0.42, y: 0.81, w: 12.38, h: 0.29 }, context, 15, { color: C.muted });
  slide.addShape(context.pptx.ShapeType.line, { x: 0.4, y: 1.16, w: 12.54, h: 0,
    line: { color: C.teal, width: 1.2 } });
  addText(slide, String(page), { x: 12.75, y: 7.12, w: 0.18, h: 0.16 }, context, 9,
    { color: C.muted, align: 'right' });
}

function proposalHeader(slide, slideSpec, context, page) {
  const sections = context.language === 'en' ? {
    background: 'Background', question: 'Scientific question', research: 'Research content',
    preliminary: 'Preliminary basis', plan: 'Research plan', references: 'References',
  } : {
    background: '研究背景', question: '科学问题', research: '研究内容',
    preliminary: '前期基础', plan: '研究计划', references: '参考文献',
  };
  slide.background = { color: context.colors.white };
  const title=slideSpec.displayTitle|| (slideSpec.kind==='research'
    ? slideSpec.title.replace(/（拟议）|\(proposed\)/gi,'').trim()
    : sections[slideSpec.kind] ?? slideSpec.title);
  addText(slide, title,
    { x: 0.55, y: 0.30, w: 12.10, h: 0.62 }, context, 32,
    { bold: true, color: context.colors.green });
  addText(slide, String(page), { x: 12.54, y: 7.12, w: 0.25, h: 0.17 }, context, 10,
    { color: context.colors.muted, align: 'right' });
}

function sourceNumbers(ids, context) {
  return [...new Set(ids ?? [])].map(id => context.references.findIndex(ref => ref.id === id)+1)
    .filter(x => x > 0).map(x => `[${x}]`).join(' ');
}

async function localImage(baseDir, relativePath) {
  const root = await fs.realpath(baseDir);
  const file = await fs.realpath(path.resolve(root, relativePath));
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error(`Image path escapes baseDir: ${relativePath}`);
  }
  if (!(await fs.stat(file)).isFile()) throw new Error(`Not an image file: ${relativePath}`);
  return file;
}

function addBar(slide, visual, frame, context) {
  const { pptx, colors: C, font } = context;
  const footnoteHeight = visual.footnote ? 0.45 : 0;
  addText(slide, visual.axis?.title ?? visual.unit,
    { x: frame.x+0.04, y: frame.y+0.15, w: frame.w-0.08, h: 0.29 }, context, 13,
    { color: C.muted, align: 'center' });
  slide.addChart(pptx.ChartType.bar, visual.series.map(series => ({
    name: series.name, labels: visual.categories, values: series.values,
  })), {
    x: frame.x+0.02, y: frame.y+0.49, w: frame.w-0.04, h: frame.h-0.52-footnoteHeight,
    barDir: 'col', barGrouping: 'clustered', catAxisLabelFontFace: font,
    catAxisLabelFontSize: 12, catAxisLabelColor: C.text, catAxisLineColor: C.muted,
    catAxisLineShow: true, catAxisMajorTickMark: 'none', catAxisLineSize: 0.7,
    valAxisLabelFontFace: font, valAxisLabelFontSize: 10, valAxisLabelColor: C.muted,
    valAxisLineShow: true, valAxisLineColor: C.muted, valAxisLineSize: 0.7,
    valAxisMajorTickMark: 'outside', valAxisMinVal: 0,
    valAxisMaxVal: visual.axis?.max, valAxisMajorUnit: visual.axis?.majorUnit,
    valAxisLabelFormatCode: visual.axis?.format ?? '0.0',
    valLabelFormatCode: visual.axis?.format ?? '0.0',
    catGridLine: { style: 'none' }, valGridLine: { style: 'none' },
    chartColors: [C.green, C.mint, C.blue], showLegend: visual.series.length > 1,
    legendPos: 'b', legendFontFace: font, legendFontSize: 10,
    showTitle: false, showValue: true, dataLabelPosition: 'outEnd',
    dataLabelFormatCode: visual.axis?.format ?? '0.0', dataLabelColor: C.green,
    dataLabelBkgrdColor: C.white, dataLabelFormatCodeSourceLinked: false,
    dataLabelFontFace: font, dataLabelFontSize: 13,
    showBorder: false, chartArea: { fill: { color: C.white } },
    plotArea: { fill: { color: C.white } },
    showCatName: false, showSerName: false, showCatNameInLegend: false,
  });
  if (visual.footnote) addText(slide, visual.footnote,
    { x: frame.x+0.04, y: frame.y+frame.h-footnoteHeight+0.02, w: frame.w-0.08, h: 0.41 },
    context, 12, { color: C.muted, align: 'center', valign: 'top' });
}

/** Draw only reported interval endpoints; an optional point must be supplied in values. */
function addInterval(slide, visual, frame, context) {
  const { pptx, colors: C } = context;
  const allLower = visual.series.flatMap(series => series.lower);
  const allUpper = visual.series.flatMap(series => series.upper);
  const minimum = visual.axis?.min ?? Math.min(0, ...allLower);
  const maximum = visual.axis?.max ?? Math.max(minimum+1, Math.max(...allUpper)*1.05);
  const majorUnit = visual.axis?.majorUnit ?? (maximum-minimum)/2;
  const footnoteHeight = visual.footnote ? 0.44 : 0;
  const labelWidth = Math.min(0.84, frame.w*0.29);
  const plotX = frame.x+labelWidth+0.10;
  const plotWidth = frame.w-labelWidth-0.22;
  const plotTop = frame.y+0.65;
  const axisY = frame.y+frame.h-footnoteHeight-0.34;
  const rowCount = visual.categories.length*visual.series.length;
  const rowHeight = (axisY-plotTop)/rowCount;
  const scale = value => plotX+(value-minimum)/(maximum-minimum)*plotWidth;
  const seriesColors = [C.green, C.blue, C.teal];
  addText(slide, visual.axis?.title ?? visual.unit,
    { x: frame.x+0.04, y: frame.y+0.10, w: frame.w-0.08, h: 0.28 }, context, 13,
    { color: C.muted, align: 'center' });
  addText(slide, `${visual.intervalLabel} (${visual.unit})`,
    { x: frame.x+0.04, y: frame.y+0.41, w: frame.w-0.08, h: 0.19 }, context, 11,
    { color: C.muted, align: 'center' });
  for (const [categoryIndex, category] of visual.categories.entries()) {
    for (const [seriesIndex, series] of visual.series.entries()) {
      const rowIndex = categoryIndex*visual.series.length+seriesIndex;
      const lineY = plotTop+rowIndex*rowHeight+0.12;
      const color = seriesColors[seriesIndex];
      const name = `interval-series-${seriesIndex}-category-${categoryIndex}`;
      addText(slide, visual.series.length === 1 ? category : `${category}\n${series.name}`,
        { x: frame.x+0.04, y: lineY-0.12, w: labelWidth-0.06, h: 0.25 }, context, 12,
        { color: C.text, objectName: `${name}-category` });
      slide.addShape(pptx.ShapeType.line, {
        x: scale(series.lower[categoryIndex]), y: lineY,
        w: scale(series.upper[categoryIndex])-scale(series.lower[categoryIndex]), h: 0,
        objectName: `${name}-segment`, line: { color, width: 2.0 },
      });
      for (const endpoint of ['lower', 'upper']) slide.addShape(pptx.ShapeType.line, {
        x: scale(series[endpoint][categoryIndex]), y: lineY-0.065, w: 0, h: 0.13,
        objectName: `${name}-${endpoint}`, line: { color, width: 1.4 },
      });
      if (series.values) slide.addShape(pptx.ShapeType.ellipse, {
        x: scale(series.values[categoryIndex])-0.035, y: lineY-0.035, w: 0.07, h: 0.07,
        objectName: `${name}-reported-point`, line: { color, width: 0.5 }, fill: { color },
      });
      const intervalText = `${series.lower[categoryIndex]}–${series.upper[categoryIndex]}`;
      addText(slide, series.values ? `${series.values[categoryIndex]} (${intervalText})` : intervalText,
        { x: plotX, y: lineY+0.10, w: plotWidth, h: 0.19 }, context, 11,
        { color, align: 'center', objectName: `${name}-range` });
    }
  }
  slide.addShape(pptx.ShapeType.line, {
    x: plotX, y: axisY, w: plotWidth, h: 0, objectName: 'interval-axis',
    line: { color: C.muted, width: 0.7 },
  });
  // A non-divisible upper bound stays as an axis extent, avoiding crowded final tick labels.
  const ticks = Math.floor((maximum-minimum)/majorUnit+1e-9);
  for (let i = 0; i <= ticks; i++) {
    const value = Number((minimum+i*majorUnit).toPrecision(12));
    slide.addShape(pptx.ShapeType.line, {
      x: scale(value), y: axisY, w: 0, h: 0.055,
      objectName: `interval-axis-tick-${i}`, line: { color: C.muted, width: 0.7 },
    });
    addText(slide, String(value),
      { x: scale(value)-0.16, y: axisY+0.075, w: 0.32, h: 0.18 }, context, 10,
      { color: C.muted, align: 'center' });
  }
  if (visual.footnote) addText(slide, visual.footnote,
    { x: frame.x+0.04, y: frame.y+frame.h-footnoteHeight+0.03, w: frame.w-0.08, h: 0.37 },
    context, 11, { color: C.muted, align: 'center', valign: 'top' });
}

function arrowSegment(slide, start, end, context, arrow = true, width = 1.4) {
  slide.addShape(context.pptx.ShapeType.line, {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    w: Math.abs(end.x-start.x), h: Math.abs(end.y-start.y),
    flipH: end.x < start.x, flipV: end.y < start.y,
    line: { color: context.colors.green, width, ...(arrow ? { endArrowType: 'triangle' } : {}) },
  });
}

/** Native diagram nodes and connectors stay individually editable in PowerPoint. */
function addDiagram(slide, visual, frame, context) {
  const vertical = visual.direction === 'vertical';
  const count = visual.nodes.length;
  const gap = vertical ? Math.min(0.23, frame.h/(count*3)) : Math.min(0.34, frame.w/(count*5));
  const nodeW = vertical ? Math.min(frame.w-0.30, 3.35)
    : (frame.w-0.16-(count-1)*gap)/count;
  const nodeH = vertical ? Math.min(0.85, (frame.h-0.30-(count-1)*gap)/count)
    : Math.min(1.12, Math.max(0.66, frame.h*0.30));
  const totalHeight = count*nodeH+(count-1)*gap;
  const boxes = new Map(visual.nodes.map((node, i) => [node.id, {
    x: vertical ? frame.x+(frame.w-nodeW)/2 : frame.x+0.08+i*(nodeW+gap),
    y: vertical ? frame.y+(frame.h-totalHeight)/2+i*(nodeH+gap) : frame.y+(frame.h-nodeH)/2,
    w: nodeW, h: nodeH, index: i,
  }]));
  // Nonadjacent links travel outside the node row/column, so they never cross labels.
  for (const [i, edge] of (visual.edges ?? []).entries()) {
    const from = boxes.get(edge.from), to = boxes.get(edge.to);
    if (!from || !to) continue; // validateSpec rejects unresolved node IDs.
    const adjacent = Math.abs(from.index-to.index) === 1;
    if (vertical) {
      const forward = to.index > from.index;
      if (adjacent) {
        arrowSegment(slide,
          { x: from.x+from.w/2, y: forward ? from.y+from.h : from.y },
          { x: to.x+to.w/2, y: forward ? to.y : to.y+to.h }, context);
      } else {
        const right = i%2 === 0;
        const lane = right ? frame.x+frame.w-0.035 : frame.x+0.035;
        const start = { x: right ? from.x+from.w : from.x, y: from.y+from.h/2 };
        const end = { x: right ? to.x+to.w : to.x, y: to.y+to.h/2 };
        arrowSegment(slide, start, { x: lane, y: start.y }, context, false);
        arrowSegment(slide, { x: lane, y: start.y }, { x: lane, y: end.y }, context, false);
        arrowSegment(slide, { x: lane, y: end.y }, end, context);
      }
    } else {
      const forward = to.index > from.index;
      if (adjacent) {
        arrowSegment(slide,
          { x: forward ? from.x+from.w : from.x, y: from.y+from.h/2 },
          { x: forward ? to.x : to.x+to.w, y: to.y+to.h/2 }, context);
      } else {
        const above = i%2 === 0;
        const lane = above ? frame.y+0.06 : frame.y+frame.h-0.06;
        const start = { x: from.x+from.w/2, y: above ? from.y : from.y+from.h };
        const end = { x: to.x+to.w/2, y: above ? to.y : to.y+to.h };
        arrowSegment(slide, start, { x: start.x, y: lane }, context, false);
        arrowSegment(slide, { x: start.x, y: lane }, { x: end.x, y: lane }, context, false);
        arrowSegment(slide, { x: end.x, y: lane }, end, context);
      }
    }
  }
  for (const node of visual.nodes) {
    const box = boxes.get(node.id);
    slide.addShape(context.pptx.ShapeType.roundRect, {
      x: box.x, y: box.y, w: box.w, h: box.h, radius: 0.06,
      line: { color: context.colors.line, width: 1 }, fill: { color: context.colors.bg },
    });
    const size = box.w < 1 ? 12 : box.w < 1.5 ? 14 : 16;
    addText(slide, node.label,
      { x: box.x+0.055, y: box.y+0.04, w: box.w-0.11, h: box.h-0.08 },
      context, size, { align: 'center', bold: true, color: context.colors.green });
  }
}

async function addVisual(slide, card, frame, context) {
  const { visual } = card;
  const L = context.labels;
  if (visual.type === 'diagram') {
    addDiagram(slide, visual, frame, context);
    return context.language === 'en' ? 'Proposed research design schematic' : '拟议研究设计示意';
  }
  if (visual.type === 'bar') {
    addBar(slide, visual, frame, context);
    return `${L.chart} ${sourceNumbers(visual.sourceIds, context)}`;
  }
  if (visual.type === 'interval') {
    addInterval(slide, visual, frame, context);
    return `${L.chart} ${sourceNumbers(visual.sourceIds, context)}`;
  }
  if (visual.type === 'image') {
    const asset = await localImage(context.baseDir, visual.path);
    const buffer = await fs.readFile(asset);
    const png = buffer.length >= 24 && buffer.subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    let placement;
    if (png) {
      const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
      if (!width || !height) throw new Error(`Invalid PNG dimensions: ${visual.path}`);
      const ratio = Math.min(frame.w/width, frame.h/height);
      const w = width*ratio, h = height*ratio;
      placement = { x: frame.x+(frame.w-w)/2, y: frame.y+(frame.h-h)/2, w, h };
    } else {
      placement = { ...frame, sizing: { type: 'contain', w: frame.w, h: frame.h } };
    }
    slide.addImage({ path: asset, ...placement, altText: visual.alt });
    return visual.role === 'source'
      ? `${L.source} ${sourceNumbers(visual.sourceIds, context)} · ${visual.license}` : L.ai;
  }
  slide.addShape(context.pptx.ShapeType.rect, {
    x: frame.x+0.06, y: frame.y+0.09, w: frame.w-0.12, h: frame.h-0.18,
    line: { color: context.colors.line, width: 1, dashType: 'dash' },
    fill: { color: context.colors.white },
  });
  addText(slide, `${L.placeholder}\n${visual.label && visual.label !== L.placeholder ? visual.label : ''}`,
    { x: frame.x+0.17, y: frame.y+frame.h/2-0.32, w: frame.w-0.34, h: 0.65 },
    context, 19, { color: context.colors.muted, align: 'center' });
  context.warnings.push(`Missing visual: ${card.id}`);
  return card.statementType === 'pending' ? L.pending : L.design;
}

function notesFor(slideSpec, context) {
  const entries = [
    `Topic: ${context.topic}\nSlide title: ${slideSpec.title}`,
    typeof slideSpec.notes === 'string' ? slideSpec.notes : (slideSpec.notes ?? []).join('\n'),
  ];
  if (slideSpec.mainQuestion) entries.push(`Main scientific question: ${slideSpec.mainQuestion}`);
  for (const card of slideSpec.cards ?? []) {
    entries.push(`${card.heading}: ${card.caption}\nStatement type: ${card.statementType}`);
    if (card.evidence) entries.push(`Evidence audit:\n${JSON.stringify(card.evidence, null, 2)}`);
    if (['bar', 'interval'].includes(card.visual?.type)) entries.push(`Native editable data:\n${JSON.stringify(card.visual, null, 2)}`);
    if (card.visual?.type === 'diagram') entries.push(`Native editable proposed design:\n${JSON.stringify(card.visual, null, 2)}`);
    if (card.visual?.type === 'image') entries.push(`Image: ${card.visual.path}\nRole: ${card.visual.role}\nLicense: ${card.visual.license ?? 'AI design; see asset manifest'}`);
    if (card.deliverable) entries.push(`Proposed deliverable: ${card.deliverable}`);
  }
  entries.push('References:\n' + context.references.map((r, i) =>
    `[${i+1}] ${r.title}. ${r.journal ?? ''} ${r.year}. ${r.doi ? `DOI: ${r.doi}. ` : ''}${r.url}\n`
    + `Source license: ${r.usage?.license ?? 'unknown; no source figure reused'}`).join('\n'));
  return entries.filter(Boolean).join('\n\n');
}

function proposalFooter(slide, slideSpec, context) {
  addText(slide, slideSpec.notice ?? context.labels.footer,
    { x: 0.57, y: 7.00, w: 11.63, h: 0.25 }, context, 11,
    { color: context.colors.muted });
  slide.addNotes(notesFor(slideSpec, context));
}

async function chainSlide(slide, slideSpec, context) {
  const stages = context.language === 'en'
    ? ['Problem', 'Current state', 'Approach', 'Objective'] : ['问题', '现状', '对策', '目标'];
  const gap = 0.24, width = (12.13-3*gap)/4;
  for (const [i, card] of slideSpec.cards.entries()) {
    const x = 0.60+i*(width+gap);
    addText(slide, stages[i], { x, y: 1.31, w: width, h: 0.40 }, context, 22,
      { color: context.colors.green, bold: true, align: 'center' });
    if (card.heading !== stages[i]) addText(slide, card.heading,
      { x: x+0.04, y: 1.80, w: width-0.08, h: 0.49 }, context, 18,
      { bold: true, align: 'center' });
    const label = await addVisual(slide, card, { x: x+0.03, y: 2.38, w: width-0.06, h: 2.68 }, context);
    addText(slide, label, { x, y: 5.15, w: width, h: 0.30 }, context, 11,
      { color: context.colors.muted, align: 'center' });
    addText(slide, card.caption, { x: x+0.03, y: 5.60, w: width-0.06, h: 1.20 }, context, 18,
      { align: 'center', valign: 'top' });
    if (i < 3) arrowSegment(slide,
      { x: x+width+0.02, y: 1.51 }, { x: x+width+gap-0.02, y: 1.51 }, context);
  }
  proposalFooter(slide, slideSpec, context);
}

async function questionSlide(slide, slideSpec, context) {
  addText(slide, slideSpec.mainQuestion,
    { x: 0.65, y: 1.24, w: 12.00, h: 0.82 }, context, 26,
    { bold: true, color: context.colors.green, align: 'center' });
  const gap = 0.46, width = (12.13-2*gap)/3;
  for (const [i, card] of slideSpec.cards.entries()) {
    const x = 0.60+i*(width+gap);
    addText(slide, card.heading, { x, y: 2.34, w: width, h: 0.52 }, context, 22,
      { color: context.colors.green, bold: true, align: 'center' });
    const label = await addVisual(slide, card, { x: x+0.04, y: 2.97, w: width-0.08, h: 2.46 }, context);
    addText(slide, label, { x, y: 5.48, w: width, h: 0.28 }, context, 11,
      { color: context.colors.muted, align: 'center' });
    addText(slide, card.caption, { x: x+0.04, y: 5.94, w: width-0.08, h: 0.80 }, context, 18,
      { align: 'center', valign: 'top' });
    if (i < 2) arrowSegment(slide,
      { x: x+width+0.07, y: 4.20 }, { x: x+width+gap-0.07, y: 4.20 }, context);
  }
  proposalFooter(slide, slideSpec, context);
}

async function splitPanel(slide, card, frame, context, compact = false) {
  const titleHeight = compact ? 0.39 : 0.66;
  const titleSize = compact ? 20 : 24;
  addText(slide, card.heading,
    { x: frame.x, y: frame.y, w: frame.w, h: titleHeight }, context, titleSize,
    { bold: true, color: context.colors.green, align: 'center' });
  const visualTop = frame.y+titleHeight+0.14;
  const captionHeight = compact ? 0.48 : 0.65;
  const deliverableHeight = card.deliverable ? (compact ? 0.39 : 0.52) : 0;
  const visualHeight = frame.h-titleHeight-captionHeight-deliverableHeight-(compact ? 0.58 : 0.75);
  const label = await addVisual(slide, card,
    { x: frame.x+0.07, y: visualTop, w: frame.w-0.14, h: visualHeight }, context);
  const labelY = visualTop+visualHeight+0.05;
  addText(slide, label, { x: frame.x, y: labelY, w: frame.w, h: 0.24 }, context, 11,
    { color: context.colors.muted, align: 'center' });
  const captionY = labelY+0.32;
  addText(slide, card.caption, { x: frame.x+0.09, y: captionY, w: frame.w-0.18, h: captionHeight },
    context, 18, { align: 'center', valign: 'top' });
  if (card.deliverable) addText(slide,
    `${context.language === 'en' ? 'Deliverable: ' : '交付：'}${card.deliverable}`,
    { x: frame.x+0.09, y: captionY+captionHeight+0.11, w: frame.w-0.18, h: deliverableHeight },
    context, 18, { color: context.colors.green, align: 'center', valign: 'top' });
}

async function splitSlide(slide, slideSpec, context) {
  const count = slideSpec.cards.length;
  if (count === 1) {
    const card = slideSpec.cards[0];
    addText(slide, card.heading, { x: 0.65, y: 1.31, w: 12.02, h: 0.59 }, context, 24,
      { bold: true, color: context.colors.green });
    const label = await addVisual(slide, card, { x: 0.68, y: 2.08, w: 7.43, h: 4.29 }, context);
    addText(slide, label, { x: 0.68, y: 6.50, w: 7.43, h: 0.27 }, context, 11,
      { color: context.colors.muted, align: 'center' });
    addText(slide, card.caption, { x: 8.63, y: 2.50, w: 3.99, h: 1.44 }, context, 22,
      { valign: 'top' });
    if (card.deliverable) addText(slide,
      `${context.language === 'en' ? 'Deliverable: ' : '交付：'}${card.deliverable}`,
      { x: 8.63, y: 4.52, w: 3.99, h: 1.09 }, context, 20,
      { color: context.colors.green, valign: 'top' });
  } else {
    const compact = count > 2;
    const gap = 0.72, width = (12.13-gap)/2;
    const height = compact ? 2.62 : 5.41;
    for (const [i, card] of slideSpec.cards.entries()) {
      await splitPanel(slide, card, {
        x: 0.60+(i%2)*(width+gap), y: 1.29+(compact ? Math.floor(i/2)*2.87 : 0),
        w: width, h: height,
      }, context, compact);
    }
  }
  proposalFooter(slide, slideSpec, context);
}

async function roadmapSlide(slide, slideSpec, context) {
  const gap = 0.28, width = (12.13-3*gap)/4;
  for (const [i, card] of slideSpec.cards.entries()) {
    const x = 0.60+i*(width+gap), center = x+width/2;
    slide.addShape(context.pptx.ShapeType.ellipse, {
      x: center-0.28, y: 1.33, w: 0.56, h: 0.56,
      fill: { color: context.colors.green }, line: { transparency: 100 },
    });
    addText(slide, String(i+1), { x: center-0.28, y: 1.36, w: 0.56, h: 0.46 },
      context, 20, { bold: true, color: context.colors.white, align: 'center' });
    if (i < 3) arrowSegment(slide,
      { x: center+0.39, y: 1.61 }, { x: center+width+gap-0.39, y: 1.61 }, context);
    addText(slide, card.heading, { x, y: 2.07, w: width, h: 0.53 }, context, 22,
      { color: context.colors.green, bold: true, align: 'center' });
    const label = await addVisual(slide, card, { x: x+0.04, y: 2.78, w: width-0.08, h: 2.58 }, context);
    addText(slide, label, { x, y: 5.47, w: width, h: 0.25 }, context, 11,
      { color: context.colors.muted, align: 'center' });
    addText(slide, card.caption, { x: x+0.04, y: 5.88, w: width-0.08, h: 0.70 }, context, 18,
      { align: 'center', valign: 'top' });
    if (card.deliverable) addText(slide, card.deliverable,
      { x: x+0.04, y: 6.61, w: width-0.08, h: 0.28 }, context, 18,
      { color: context.colors.green, align: 'center' });
  }
  proposalFooter(slide, slideSpec, context);
}

async function proposalSlide(slide, slideSpec, context) {
  const layout = slideSpec.layout ?? ({
    background: 'chain', question: 'question', research: 'split', preliminary: 'split', plan: 'roadmap',
  })[slideSpec.kind];
  if (layout === 'chain') await chainSlide(slide, slideSpec, context);
  else if (layout === 'question') await questionSlide(slide, slideSpec, context);
  else if (layout === 'split') await splitSlide(slide, slideSpec, context);
  else if (layout === 'roadmap') await roadmapSlide(slide, slideSpec, context);
  else throw new Error(`Unsupported proposal layout: ${layout}`);
}

async function cardsSlide(slide, slideSpec, context) {
  const C = context.colors;
  const colors = [C.blue, C.teal, C.mint, C.gold];
  for (const [i, card] of slideSpec.cards.entries()) {
    const x = S.left + i*(S.cardWidth + S.gap);
    slide.addShape(context.pptx.ShapeType.rect, { x, y: 1.36, w: S.cardWidth, h: 0.56,
      line: { color: C.green, transparency: 100 }, fill: { color: C.green } });
    addText(slide, `${String(i+1).padStart(2, '0')}  ${card.heading}`,
      { x: x+0.07, y: 1.40, w: S.cardWidth-0.14, h: 0.46 }, context, 18,
      { bold: true, color: C.white, align: 'center' });
    if (i < 3) slide.addShape(context.pptx.ShapeType.chevron,
      { x: x+S.cardWidth+0.018, y: 1.55, w: 0.104, h: 0.20,
        line: { transparency: 100 }, fill: { color: C.teal } });
    slide.addShape(context.pptx.ShapeType.rect, { x, y: 2.08, w: S.cardWidth, h: 4.36,
      line: { color: C.line, width: 0.7 }, fill: { color: C.white } });
    slide.addShape(context.pptx.ShapeType.rect, { x, y: 2.04, w: S.cardWidth, h: 0.04,
      line: { transparency: 100 }, fill: { color: colors[i] } });
    const visualLabel = await addVisual(slide, card,
      { x: x+0.075, y: 2.16, w: S.cardWidth-0.15, h: 2.98 }, context);
    addText(slide, visualLabel, { x: x+0.1, y: 5.17, w: S.cardWidth-0.2, h: 0.25 },
      context, 10, { color: C.muted, align: 'center' });
    addText(slide, card.caption, { x: x+0.14, y: 5.47, w: S.cardWidth-0.28, h: 0.60 },
      context, 15, { align: 'center' });
    addText(slide, context.labels[card.statementType],
      { x: x+0.13, y: 6.16, w: S.cardWidth-0.26, h: 0.19 },
      context, 10, { color: C.muted, align: 'center' });
  }
  const notice = slideSpec.notice ?? context.labels.footer;
  addText(slide, notice, { x: 0.45, y: 6.70, w: 12.38, h: 0.34 }, context, 13,
    { color: C.muted, align: 'center' });
  slide.addNotes(notesFor(slideSpec, context));
}

function referencesSlide(slide, slideSpec, context) {
  const refs = context.references;
  const columns = refs.length > 4 ? 2 : 1;
  const rows = Math.ceil(refs.length/columns) || 1;
  const rowHeight = 5.4/rows;
  for (const [i, ref] of refs.entries()) {
    const column = columns === 1 ? 0 : Math.floor(i/rows);
    const row = columns === 1 ? i : i%rows;
    const x = 0.48 + column*6.40;
    const w = columns === 1 ? 12.24 : 5.95;
    const y = 1.42 + row*rowHeight;
    const author = Array.isArray(ref.authors) ? `${ref.authors[0] ?? ''}${ref.authors.length > 1 ? ' et al.' : ''}` : (ref.authors ?? '');
    const citation = `[${i+1}] ${author} ${ref.title}\n${ref.journal ?? ''} ${ref.year}${ref.doi ? ` · DOI: ${ref.doi}` : ''}`;
    addText(slide, citation, { x, y, w, h: Math.min(rowHeight-0.27, 1.18) }, context,
      refs.length > 8 ? 11 : 14, { valign: 'top' });
    addText(slide, ref.url, { x, y: y+Math.min(rowHeight-0.29, 1.19), w, h: 0.20 }, context,
      refs.length > 8 ? 9 : 11, { color: context.colors.teal, hyperlink: { url: ref.url } });
  }
  addText(slide, slideSpec.notice ?? (context.template === 'proposal'
    ? context.labels.proposalReferenceFooter : context.labels.referenceFooter),
    { x: 0.48, y: 6.88, w: 12.15, h: 0.26 }, context, 11,
    { color: context.colors.muted });
  slide.addNotes(notesFor(slideSpec, context));
}

/** Build a real PPTX without private runtimes, connectors, or network access. */
export async function renderPresentation(input, { baseDir = process.cwd(), outputPath = 'research-slides.pptx' } = {}) {
  const spec = validateSpec(input);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Research Slide Workflow';
  pptx.subject = spec.topic ?? spec.title;
  pptx.title = spec.title;
  pptx.company = '';
  pptx.lang = spec.language === 'en' ? 'en-US' : 'zh-CN';
  const colors = { ...DEFAULT_COLORS };
  for (const [key, value] of Object.entries(spec.theme?.colors ?? {})) {
    if (Object.hasOwn(colors, key) && cleanHex(value)) colors[key] = cleanHex(value);
  }
  const context = {
    pptx, colors, font: spec.theme?.fontFace ?? 'Arial',
    references: spec.references, labels: locale(spec.language),
    baseDir: path.resolve(baseDir), warnings: [], language: spec.language, topic: spec.topic ?? spec.title,
    template: spec.template,
  };
  pptx.theme = { headFontFace: context.font, bodyFontFace: context.font, lang: pptx.lang };
  for (const [index, item] of spec.slides.entries()) {
    const slide = pptx.addSlide();
    if (spec.template === 'proposal') proposalHeader(slide, item, context, index+1);
    else header(slide, spec, item, context, index+1);
    if (item.kind === 'references') referencesSlide(slide, item, context);
    else if (spec.template === 'proposal') await proposalSlide(slide, item, context);
    else await cardsSlide(slide, item, context);
  }
  const destination = path.resolve(outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await pptx.writeFile({ fileName: destination, compression: true });
  await repairMasterContentTypes(destination);
  await normaliseSingleLevelChartCategories(destination);
  return { outputPath: destination, slideCount: spec.slides.length, warnings: context.warnings };
}

export default renderPresentation;
