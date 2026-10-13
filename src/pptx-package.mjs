import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';

const MASTER_PART = /^ppt\/slideMasters\/slideMaster\d+\.xml$/;
const MASTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const XML_TOKENS = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;

function decodeAttribute(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key) => {
    const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function tags(xml, name) {
  const result = [];
  for (const match of xml.matchAll(XML_TOKENS)) {
    const tagName = match[0].match(/^<([A-Za-z_][\w:.-]*)\b/)?.[1].split(':').at(-1);
    if (tagName !== name) continue;
    const attributes = {};
    for (const attr of match[0].matchAll(/\s([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[attr[1]] = decodeAttribute(attr[2] ?? attr[3]);
    }
    result.push({text: match[0], index: match.index, attributes});
  }
  return result;
}

function decodePartUri(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function referencedPart(relsName, target) {
  // OPC relationships are relative to their source part, not the _rels folder.
  const source = relsName === '_rels/.rels' ? ''
    : relsName.replace(/(^|\/)\_rels\/([^/]+)\.rels$/, '$1$2');
  const value = decodePartUri(target.split(/[?#]/, 1)[0]);
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) return null;
  return path.posix.normalize(value.startsWith('/') ? value.slice(1)
    : path.posix.join(path.posix.dirname(source), value));
}

async function savePackage(zip, filename) {
  const output = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}});
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.repair-${randomUUID()}.tmp`);
  try {
    const {mode} = await fs.stat(filename);
    await fs.writeFile(temporary, output, {mode});
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, {force: true}); }
}

/** Repair only PptxGenJS's unreferenced, nonexistent slide-master overrides. */
export async function repairMasterContentTypes(filename) {
  const input = await fs.readFile(filename);
  const zip = await JSZip.loadAsync(input);
  const part = zip.file('[Content_Types].xml');
  if (!part) throw new Error('Invalid PPTX package: [Content_Types].xml is missing');
  const xml = await part.async('string');
  const missing = tags(xml, 'Override').filter(tag => {
    const name = decodePartUri(tag.attributes.PartName ?? '').replace(/^\//, '');
    return MASTER_PART.test(name) && tag.attributes.ContentType === MASTER_CONTENT_TYPE && !zip.file(name);
  });
  if (!missing.length) return {removedOverrides: [], repaired: false};
  for (const tag of missing) {
    if (/\/\s*>$/.test(tag.text)) continue;
    const closing = xml.slice(tag.index+tag.text.length).match(/^\s*<\/(?:[A-Za-z_][\w.-]*:)?Override\s*>/);
    if (!closing) throw new Error(`Cannot repair a nonempty slide-master override: ${tag.attributes.PartName}`);
    tag.text += closing[0];
  }

  const references = new Set();
  const relationships = await Promise.all(zip.file(/\.rels$/).map(async file => ({
    name: file.name, xml: await file.async('string'),
  })));
  for (const file of relationships) {
    for (const {attributes} of tags(file.xml, 'Relationship')) {
      if (attributes.TargetMode === 'External' || !attributes.Target) continue;
      const target = referencedPart(file.name, attributes.Target);
      if (target) references.add(target);
    }
  }
  for (const tag of missing) {
    const name = decodePartUri(tag.attributes.PartName).replace(/^\//, '');
    if (references.has(name)) throw new Error(`Referenced slide master is missing: /${name}`);
  }
  let repairedXml = xml;
  for (const tag of [...missing].reverse()) {
    repairedXml = repairedXml.slice(0, tag.index)+repairedXml.slice(tag.index+tag.text.length);
  }
  zip.file('[Content_Types].xml', repairedXml);
  await savePackage(zip, filename);
  return {removedOverrides: missing.map(tag => tag.attributes.PartName), repaired: true};
}

function chartElements(xml, filename) {
  const stack = [], elements = [];
  for (const match of xml.matchAll(XML_TOKENS)) {
    const marker = match[0].match(/^<(\/?)([A-Za-z_][\w:.-]*)\b/);
    if (!marker) continue;
    const [, closing, name] = marker;
    if (closing) {
      const element = stack.pop();
      if (!element || element.name !== name) throw new Error(`Invalid chart XML structure: ${filename}`);
      element.closeStart = match.index;
      element.end = match.index+match[0].length;
    } else {
      const element = {name, parent: stack.at(-1), index: match.index,
        openEnd: match.index+match[0].length, opening: match[0]};
      elements.push(element);
      if (/\/\s*>$/.test(match[0])) element.closeStart = element.end = element.openEnd;
      else stack.push(element);
    }
  }
  if (stack.length) throw new Error(`Invalid chart XML structure: ${filename}`);
  return elements;
}

function attribute(element, name) {
  return tags(element.opening, element.name.split(':').at(-1))[0]?.attributes[name];
}

function normaliseChartXml(xml, filename) {
  const elements = chartElements(xml, filename), changes = [];
  const children = (parent, name) => elements.filter(element => element.parent === parent && element.name === name);
  const content = element => xml.slice(element.openEnd, element.closeStart);
  const fail = reason => { throw new Error(`Invalid single-level chart category cache in ${filename}: ${reason}`); };
  const rename = (element, name) => {
    changes.push({start: element.index, end: element.openEnd,
      value: element.opening.replace(element.name, name)});
    if (element.closeStart < element.end) changes.push({start: element.closeStart, end: element.end,
      value: xml.slice(element.closeStart, element.end).replace(element.name, name)});
  };
  let count = 0;
  for (const cat of elements.filter(element => element.name === 'c:cat')) {
    const refs = children(cat, 'c:multiLvlStrRef');
    if (!refs.length) continue;
    if (refs.length !== 1) fail('category must contain one reference');
    const ref = refs[0], caches = children(ref, 'c:multiLvlStrCache');
    if (caches.length !== 1) fail('reference must contain one cache');
    const cache = caches[0], levels = children(cache, 'c:lvl');
    if (levels.length >= 2) continue; // Genuine hierarchical categories remain byte-for-byte unchanged.
    if (levels.length !== 1) fail('cache must contain a level');
    const formulas = children(ref, 'c:f'), totals = children(cache, 'c:ptCount');
    if (formulas.length !== 1 || !content(formulas[0]).trim()) fail('formula is missing or ambiguous');
    if (totals.length !== 1) fail('ptCount is missing or ambiguous');
    const totalText = attribute(totals[0], 'val');
    if (!/^(?:0|[1-9]\d*)$/.test(totalText ?? '')) fail('ptCount is not a valid unsigned integer');
    const total = Number(totalText);
    if (!Number.isSafeInteger(total) || total > 0xffffffff) fail('ptCount is out of range');
    const level = levels[0], points = children(level, 'c:pt');
    if (points.length !== total || children(cache, 'c:pt').length) fail('point count does not match ptCount');
    const indexes = [];
    for (const point of points) {
      const indexText = attribute(point, 'idx');
      if (!/^\d+$/.test(indexText ?? '') || !Number.isSafeInteger(Number(indexText))) fail('point index is invalid');
      indexes.push(Number(indexText));
      if (children(point, 'c:v').length !== 1) fail('point must contain exactly one string value');
    }
    if (indexes.sort((a, b) => a-b).some((index, i) => index !== i)) fail('point indexes must cover 0 through ptCount minus one');
    rename(ref, 'c:strRef');
    rename(cache, 'c:strCache');
    changes.push({start: level.index, end: level.openEnd, value: ''});
    if (level.closeStart < level.end) changes.push({start: level.closeStart, end: level.end, value: ''});
    count++;
  }
  let result = xml;
  for (const change of changes.sort((a, b) => b.start-a.start)) {
    result = result.slice(0, change.start)+change.value+result.slice(change.end);
  }
  return {xml: result, count};
}

/** Normalise PptxGenJS's c:-prefixed flat categories without changing chart data. */
export async function normaliseSingleLevelChartCategories(filename) {
  const zip = await JSZip.loadAsync(await fs.readFile(filename));
  const charts = await Promise.all(zip.file(/^ppt\/charts\/chart\d+\.xml$/).map(async file => ({
    name: file.name, ...normaliseChartXml(await file.async('string'), file.name),
  })));
  const changed = charts.filter(chart => chart.count > 0);
  if (!changed.length) return {normalisedCharts: [], normalisedCategories: 0, repaired: false};
  for (const chart of changed) zip.file(chart.name, chart.xml);
  await savePackage(zip, filename);
  return {normalisedCharts: changed.map(chart => chart.name),
    normalisedCategories: changed.reduce((sum, chart) => sum+chart.count, 0), repaired: true};
}
