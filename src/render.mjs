import fs from 'node:fs/promises';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { validateSpec } from './schema.mjs';

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
} : {
  proposed: '拟议设计', pending: '证据待核实', evidence: '公开文献证据', design: '设计示意',
  ai: 'AI设计示意', source: '文献原图', chart: '据文献数据重绘',
  placeholder: '需配图', footer: '研究与计划为拟议设计，未声称已取得项目结果。',
  referenceFooter: '数字据所列公开来源；AI设计图为独立可替换的示意图片。',
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
  addText(slide, visual.axis?.title ?? visual.unit,
    { x: frame.x+0.04, y: frame.y+0.15, w: frame.w-0.08, h: 0.29 }, context, 13,
    { color: C.muted, align: 'center' });
  slide.addChart(pptx.ChartType.bar, visual.series.map(series => ({
    name: series.name, labels: visual.categories, values: series.values,
  })), {
    x: frame.x+0.02, y: frame.y+0.49, w: frame.w-0.04, h: frame.h-0.52,
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
}

async function addVisual(slide, card, frame, context) {
  const { visual } = card;
  const L = context.labels;
  if (visual.type === 'bar') {
    addBar(slide, visual, frame, context);
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
  const entries = [typeof slideSpec.notes === 'string' ? slideSpec.notes : (slideSpec.notes ?? []).join('\n')];
  for (const card of slideSpec.cards ?? []) {
    entries.push(`${card.heading}: ${card.caption}\nStatement type: ${card.statementType}`);
    if (card.evidence) entries.push(`Evidence audit:\n${JSON.stringify(card.evidence, null, 2)}`);
    if (card.visual?.type === 'bar') entries.push(`Native editable data:\n${JSON.stringify(card.visual, null, 2)}`);
    if (card.visual?.type === 'image') entries.push(`Image: ${card.visual.path}\nRole: ${card.visual.role}\nLicense: ${card.visual.license ?? 'AI design; see asset manifest'}`);
  }
  entries.push('References:\n' + context.references.map((r, i) =>
    `[${i+1}] ${r.title}. ${r.journal ?? ''} ${r.year}. ${r.doi ? `DOI: ${r.doi}. ` : ''}${r.url}\n`
    + `Source license: ${r.usage?.license ?? 'unknown; no source figure reused'}`).join('\n'));
  return entries.filter(Boolean).join('\n\n');
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
  addText(slide, slideSpec.notice ?? context.labels.referenceFooter,
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
    baseDir: path.resolve(baseDir), warnings: [],
  };
  pptx.theme = { headFontFace: context.font, bodyFontFace: context.font, lang: pptx.lang };
  for (const [index, item] of spec.slides.entries()) {
    const slide = pptx.addSlide();
    header(slide, spec, item, context, index+1);
    if (item.kind === 'references') referencesSlide(slide, item, context);
    else await cardsSlide(slide, item, context);
  }
  const destination = path.resolve(outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await pptx.writeFile({ fileName: destination, compression: true });
  return { outputPath: destination, slideCount: spec.slides.length, warnings: context.warnings };
}

export default renderPresentation;
