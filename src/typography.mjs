import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';

const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const XML_TOKENS = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
const XML_ATTRIBUTES = /\s([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CHARACTER_PROPERTIES = new Set(['rPr', 'defRPr', 'endParaRPr']);
// DrawingML CT_TextCharacterProperties and CT_FontCollection sequence, as defined
// by https://github.com/dotnet/Open-XML-SDK/tree/main/data/schemas .
const PROPERTY_ORDER = new Map([
  ['ln', 0], ...['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].map(name => [name, 1]),
  ['effectLst', 2], ['effectDag', 2], ['highlight', 3], ['uLnTx', 4], ['uLn', 4],
  ['uFillTx', 5], ['uFill', 5], ['latin', 6], ['ea', 7], ['cs', 8], ['sym', 9],
  ['hlinkClick', 10], ['hlinkMouseOver', 11], ['rtl', 12], ['extLst', 13],
]);
const COLLECTION_ORDER = new Map([['latin', 0], ['ea', 1], ['cs', 2], ['font', 3], ['extLst', 4]]);

function decodeXml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key) => {
    const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

const encodeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function fontName(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\ufffe\uffff]/u.test(value)
    || [...value].some(char => char.length === 1 && /[\ud800-\udfff]/u.test(char))) {
    throw new TypeError(`${name} must be a non-empty font family without invalid XML characters.`);
  }
  return value.trim();
}

function attributes(opening) {
  return new Map([...opening.matchAll(XML_ATTRIBUTES)].map(match => [match[1], decodeXml(match[2] ?? match[3])]));
}

/** Tokenize without serializing XML, so content, numbers and geometry stay exact. */
function elementsOf(xml, filename) {
  const elements = [], stack = [];
  for (const match of xml.matchAll(XML_TOKENS)) {
    const marker = match[0].match(/^<(\/?)([A-Za-z_][\w:.-]*)\b/);
    if (!marker) continue; // Comments, processing instructions and CDATA are opaque.
    const [, closing, name] = marker;
    if (closing) {
      const element = stack.pop();
      if (!element || element.name !== name) throw new Error(`Invalid XML structure in ${filename}.`);
      element.closeStart = match.index;
      element.end = match.index + match[0].length;
      continue;
    }
    const parent = stack.at(-1), attr = attributes(match[0]);
    const namespaces = new Map(parent?.namespaces);
    for (const [key, value] of attr) {
      if (key === 'xmlns') namespaces.set('', value);
      else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), value);
    }
    const split = name.indexOf(':'), prefix = split < 0 ? '' : name.slice(0, split);
    const element = {name, prefix, local: split < 0 ? name : name.slice(split + 1),
      namespace: namespaces.get(prefix), namespaces, attr, parent, children: [],
      index: match.index, openEnd: match.index + match[0].length, opening: match[0],
      selfClosing: /\/\s*>$/.test(match[0])};
    parent?.children.push(element);
    elements.push(element);
    if (element.selfClosing) element.closeStart = element.end = element.openEnd;
    else stack.push(element);
  }
  if (stack.length) throw new Error(`Invalid XML structure in ${filename}.`);
  return elements;
}

const drawing = element => DRAWING_NAMESPACES.has(element.namespace);
const qualified = (element, local) => element.prefix ? `${element.prefix}:${local}` : local;
const fontTag = (element, local, value) => `<${qualified(element, local)} typeface="${encodeXml(value)}"/>`;

function withTypeface(opening, value) {
  const attr = [...opening.matchAll(XML_ATTRIBUTES)].find(match => match[1] === 'typeface');
  if (attr) {
    if (decodeXml(attr[2] ?? attr[3]) === value) return opening;
    const quote = attr[2] === undefined ? "'" : '"';
    const prefix = attr[0].slice(0, attr[0].indexOf(quote) + 1);
    return opening.slice(0, attr.index) + prefix + encodeXml(value) + quote
      + opening.slice(attr.index + attr[0].length);
  }
  return opening.replace(/(\/?>)$/, ending => ` typeface="${encodeXml(value)}"${ending}`);
}

function scriptFontsInXml(xml, filename, fonts) {
  const elements = elementsOf(xml, filename), edits = [], insertions = new Map();
  let updatedProperties = 0;
  const insert = (index, value) => insertions.set(index, (insertions.get(index) ?? '') + value);
  const replace = (start, end, value) => {if (xml.slice(start, end) !== value) edits.push({start, end, value});};
  const applyCollection = (element, theme = false) => {
    const children = element.children.filter(drawing), order = theme ? COLLECTION_ORDER : PROPERTY_ORDER;
    const wanted = [['latin', fonts.latin], ['ea', fonts.eastAsian]];
    // CT_FontCollection requires cs. Add an empty slot only when absent; never
    // replace complex-script, symbol or bullet font choices.
    if (theme && !children.some(child => child.local === 'cs')) wanted.push(['cs', '']);
    let changed = false;
    if (element.selfClosing) {
      replace(element.index, element.openEnd, element.opening.replace(/\/\s*>$/, '>')
        + wanted.map(([local, value]) => fontTag(element, local, value)).join('') + `</${element.name}>`);
      updatedProperties++;
      return;
    }
    for (const [local, value] of wanted) {
      const matches = children.filter(child => child.local === local);
      if (matches.length > 1) throw new Error(`Duplicate ${local} font slot in ${filename}.`);
      if (matches.length) {
        const child = matches[0], opening = withTypeface(child.opening, value);
        changed ||= opening !== child.opening;
        replace(child.index, child.openEnd, opening);
      } else {
        const next = children.find(child => (order.get(child.local) ?? Infinity) > order.get(local));
        insert(next?.index ?? element.closeStart, fontTag(element, local, value));
        changed = true;
      }
    }
    if (theme) for (const child of children.filter(child => child.local === 'font'
      && ['Hans', 'Hant'].includes(child.attr.get('script')))) {
      const opening = withTypeface(child.opening, fonts.eastAsian);
      changed ||= opening !== child.opening;
      replace(child.index, child.openEnd, opening);
    }
    if (changed) updatedProperties++;
  };
  for (const element of elements.filter(drawing)) {
    if (CHARACTER_PROPERTIES.has(element.local)) applyCollection(element);
    else if (['majorFont', 'minorFont'].includes(element.local)) applyCollection(element, true);
    else if (['r', 'fld', 'br'].includes(element.local)
      && !element.children.some(child => drawing(child) && child.local === 'rPr')) {
      const property = `<${qualified(element, 'rPr')}>${fontTag(element, 'latin', fonts.latin)}${fontTag(element, 'ea', fonts.eastAsian)}</${qualified(element, 'rPr')}>`;
      if (element.selfClosing) replace(element.index, element.openEnd,
        element.opening.replace(/\/\s*>$/, '>') + property + `</${element.name}>`);
      else insert(element.openEnd, property); // rPr precedes pPr/t in a:fld and t in a:r.
      updatedProperties++;
    }
  }
  for (const [index, value] of insertions) edits.push({start: index, end: index, value});
  let result = xml;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  // Ensure insertion/replacement did not introduce mismatched tags or namespace scope.
  if (result !== xml) elementsOf(result, filename);
  return {xml: result, updatedProperties};
}

async function savePackage(zip, filename) {
  const output = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}});
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.fonts-${randomUUID()}.tmp`);
  try {
    const {mode} = await fs.stat(filename);
    await fs.writeFile(temporary, output, {mode});
    await fs.rename(temporary, filename);
  } finally {await fs.rm(temporary, {force: true});}
}

/** Set Latin/East Asian script fonts in native PPT text; media/workbooks stay intact. */
export async function applyScriptFonts(filename, {eastAsian = '微软雅黑', latin = 'Arial'} = {}) {
  const fonts = {eastAsian: fontName(eastAsian, 'eastAsian'), latin: fontName(latin, 'latin')};
  const zip = await JSZip.loadAsync(await fs.readFile(filename));
  if (!zip.file('[Content_Types].xml')) throw new Error('Invalid PPTX package: [Content_Types].xml is missing.');
  const parts = zip.file(/^ppt\/.*\.xml$/).filter(file => !/^ppt\/(?:media|embeddings)\//.test(file.name));
  const results = await Promise.all(parts.map(async file => {
    const original = await file.async('string');
    return {name: file.name, original, ...scriptFontsInXml(original, file.name, fonts)};
  }));
  const changed = results.filter(result => result.xml !== result.original);
  if (changed.length) {
    for (const result of changed) zip.file(result.name, result.xml);
    await savePackage(zip, filename);
  }
  return {...fonts, updatedParts: changed.map(result => result.name),
    updatedProperties: changed.reduce((sum, result) => sum + result.updatedProperties, 0), changed: changed.length > 0};
}
