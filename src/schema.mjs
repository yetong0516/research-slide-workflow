import path from 'node:path';

export class SpecValidationError extends Error {
  constructor(issues) {
    super(`Invalid slide specification:\n${issues.map(x => `- ${x}`).join('\n')}`);
    this.name = 'SpecValidationError';
    this.issues = issues;
  }
}

const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const list = x => Array.isArray(x) ? x : [];
const genericEvidenceHeadings = new Set([
  '文献证据', '已核对文献证据', '研究背景', '公开文献数据',
  '问题的重要性', '既有方法', '候选补充信息', '研究缺口',
  'Published evidence', 'Checked evidence', 'Research background',
]);
const checkedClaim = x => x && ['checked', 'verified'].includes(x.status)
  && x.reviewed === true && nonempty(x.reviewer) && nonempty(x.locator)
  && (nonempty(x.reviewNote) || nonempty(x.notes) || list(x.notes).some(nonempty));
const chartDataSignature = visual => JSON.stringify({
  type: visual?.type, categories: visual?.categories,
  series: list(visual?.series).map(s => ({ name: s.name, values: s.values })),
  unit: visual?.unit, sourceIds: visual?.sourceIds, locator: visual?.locator,
  statistic: visual?.statistic, footnote: visual?.footnote,
});
const imageSignature = visual => JSON.stringify({
  type: visual?.type, role: visual?.role, path: visual?.path,
  sourceIds: visual?.sourceIds, locator: visual?.locator,
  license: visual?.license?.trim(), permission: visual?.permission,
});
function knownReuseLicense(value, permission) {
  if (!nonempty(value)) return false;
  const license = value.trim();
  if (/^(?:unknown|unverified|pending|tbd|unset|none|unlicensed)\b|^(?:未知|待核实|待确认)/i.test(license)) return false;
  return /^(?:MIT|Apache-2\.0|BSD-[23]-Clause|CC0(?:-1\.0)?|Public[ -]Domain)$/i.test(license)
    || /^CC[ -]BY(?:[ -](?:SA|NC|ND|NC-SA|NC-ND))?[ -][1-4]\.0$/i.test(license)
    || (permission?.status === 'granted' && nonempty(permission.scope) && nonempty(permission.source));
}

/** Accept the public card schema and the planner's equivalent panel aliases. */
export function normaliseSpec(input) {
  const out = structuredClone(input);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  out.title ??= out.topic;
  out.references ??= out.sources ?? [];
  if (!Array.isArray(out.slides)) return out;
  out.slides = out.slides.map((slide, si) => {
    const next = { ...slide, id: slide.id ?? `slide-${si+1}` };
    if (next.kind === 'content') next.kind = 'research';
    if (next.kind === 'references') return next;
    const items = next.cards ?? next.panels;
    next.cards = list(items).map((card, ci) => {
      const result = { ...card, id: card.id ?? `${next.id}-card-${ci+1}` };
      result.heading ??= result.title;
      result.caption ??= '';
      result.statementType ??= card.status === 'verified' ? 'evidence'
        : card.status === 'pending' ? 'pending' : 'proposed';
      if (!result.evidence && list(card.claimIds).length) {
        result.evidence = {
          status: 'checked', sourceIds: list(card.sourceIds), claimIds: card.claimIds,
          locator: card.locator,
        };
      }
      if (!result.visual) {
        if (card.chartData) result.visual = { type: 'bar', ...card.chartData };
        else if (card.imagePath) result.visual = {
          type: 'image', path: card.imagePath, role: 'design',
          alt: card.imageAlt ?? card.caption ?? card.title,
          provenance: card.imageProvenance,
        };
        else result.visual = { type: 'placeholder', role: 'design', label: '需配图' };
      }
      if (result.visual.type === 'bar') {
        result.visual.sourceIds ??= result.evidence?.sourceIds ?? card.sourceIds ?? [];
      }
      return result;
    });
    return next;
  });
  return out;
}

export const normalizeSpec = normaliseSpec;

/** Validation does not retrieve sources, certify figures, or upgrade evidence. */
export function validateSpec(input) {
  const spec = normaliseSpec(input);
  const issues = [];
  const check = (ok, message) => { if (!ok) issues.push(message); };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new SpecValidationError(['spec must be an object']);
  }
  check(spec.schemaVersion === 1, 'schemaVersion must be 1');
  check(nonempty(spec.title), 'title is required');
  check(Array.isArray(spec.references), 'references must be an array');
  check(Array.isArray(spec.slides), 'slides must be an array');
  const proposal = spec.template === 'proposal';
  check(spec.template === undefined || ['compact', 'proposal'].includes(spec.template),
    'template must be compact or proposal');
  const refs = list(spec.references);
  const sources = new Map();
  refs.forEach((ref, i) => {
    check(nonempty(ref.id), `references[${i}].id is required`);
    check(!sources.has(ref.id), `duplicate reference id: ${ref.id}`);
    check(nonempty(ref.title), `references[${i}].title is required`);
    check(Number.isInteger(ref.year) && ref.year >= 1800 && ref.year <= 2200,
      `references[${i}].year must be a four-digit publication year`);
    check(nonempty(ref.url) && /^https?:\/\//.test(ref.url),
      `references[${i}].url must be an HTTP(S) source URL`);
    if (ref.metadataVerified === true && ref.verification?.status !== undefined) {
      check(ref.verification.status === 'verified',
        `references[${i}] metadataVerified contradicts verification.status`);
    }
    sources.set(ref.id, ref);
  });
  const verifyIds = (ids, where) => {
    check(Array.isArray(ids) && ids.length > 0, `${where} needs at least one sourceId`);
    list(ids).forEach(id => check(sources.has(id), `${where} has unknown sourceId: ${id}`));
  };
  const slides = list(spec.slides);
  check(proposal ? slides.length >= 7 && slides.length <= 9 : slides.length >= 4 && slides.length <= 5,
    proposal ? 'proposal requires 7 slides plus up to 2 reviewed preliminary slides'
      : 'workflow requires background 1, research 1–2, plan 1, references 1 (4–5 slides)');
  const counts = proposal
    ? { background: 0, question: 0, research: 0, preliminary: 0, plan: 0, references: 0 }
    : { background: 0, research: 0, plan: 0, references: 0 };
  const cardIds = new Set();
  const slideIds = new Set();
  slides.forEach((slide, si) => {
    const where = `slides[${si}]`;
    check(Object.hasOwn(counts, slide.kind), `${where}.kind is not supported`);
    if (Object.hasOwn(counts, slide.kind)) counts[slide.kind]++;
    check(nonempty(slide.title), `${where}.title is required`);
    check(!slideIds.has(slide.id), `duplicate slide id: ${slide.id}`);
    slideIds.add(slide.id);
    if (slide.kind === 'references') return;
    const count = list(slide.cards).length;
    const expected = proposal && slide.kind === 'question' ? 3
      : proposal && slide.kind === 'research' ? 2 : 4;
    check(Array.isArray(slide.cards) && (proposal && slide.kind === 'preliminary'
      ? count >= 1 && count <= 2 : count === expected),
    `${where} must contain ${proposal && slide.kind === 'preliminary' ? 'one or two' : expected} cards`);
    if (proposal && slide.kind === 'question') {
      check(nonempty(slide.mainQuestion) && [...slide.mainQuestion].length <= 100,
        `${where}.mainQuestion must contain 1–100 characters`);
    }
    list(slide.cards).forEach((card, ci) => {
      const at = `${where}.cards[${ci}]`;
      check(nonempty(card.id), `${at}.id is required`);
      check(!cardIds.has(card.id), `duplicate card id: ${card.id}`);
      cardIds.add(card.id);
      check(nonempty(card.heading), `${at}.heading is required`);
      check(!card.heading || [...card.heading].length <= 30,
        `${at}.heading must be short (≤30 characters)`);
      check(typeof card.caption === 'string' && [...card.caption].length <= 120,
        `${at}.caption must be a short string (≤120 characters)`);
      check(['evidence', 'proposed', 'design', 'pending'].includes(card.statementType),
        `${at}.statementType must be evidence, proposed, design, or pending`);
      if (proposal && slide.kind === 'preliminary') {
        check(card.statementType === 'evidence' && ['bar', 'image'].includes(card.visual?.type),
          `${at} preliminary work requires reviewed evidence and a real figure or dataset`);
      }
      if (card.statementType === 'evidence') {
        const evidence = card.evidence;
        check(evidence?.status === 'checked', `${at} evidence must have status checked`);
        verifyIds(evidence?.sourceIds, `${at}.evidence`);
        const claims = list(evidence?.claimIds).flatMap(id => refs.flatMap(ref =>
          list(ref.claims).filter(claim => claim.id === id)));
        if (list(evidence?.claimIds).length) {
          check(claims.length === evidence.claimIds.length,
            `${at}.evidence claimIds must resolve uniquely`);
          check(claims.every(checkedClaim),
            `${at} requires independently reviewed claims with reviewer, reviewNote and locator`);
          claims.forEach(claim => {
            verifyIds(claim.sourceIds, `${at}.claim ${claim.id}`);
            check(list(claim.sourceIds).every(id => list(evidence.sourceIds).includes(id)),
              `${at} claim sources must also appear in evidence.sourceIds`);
            check(card.caption === (claim.approvedCaption ?? claim.text),
              `${at}.caption must equal the independently reviewed claim text or approvedCaption`);
            check((nonempty(claim.heading) && card.heading === claim.heading)
              || (!nonempty(claim.heading) && genericEvidenceHeadings.has(card.heading)),
              `${at}.heading must match the independently reviewed claim heading`);
          });
        } else {
          check(false, `${at} requires reference claimIds; direct card self-review is not accepted`);
        }
        card._reviewedClaims = claims;
      }
      const visual = card.visual;
      check(visual && ['placeholder', 'image', 'bar', 'diagram'].includes(visual.type),
        `${at}.visual.type must be placeholder, image, bar, or diagram`);
      if (!visual) return;
      if (visual.type === 'diagram') {
        check(visual.role === 'design' && ['proposed', 'design'].includes(card.statementType),
          `${at} native diagrams describe proposed concepts, not empirical evidence`);
        check(['horizontal', 'vertical'].includes(visual.direction),
          `${at}.diagram.direction must be horizontal or vertical`);
        const nodes = list(visual.nodes), ids = new Set(nodes.map(node => node.id));
        check(Array.isArray(visual.nodes) && nodes.length >= 2 && nodes.length <= 5,
          `${at}.diagram needs 2–5 labelled nodes`);
        check(ids.size === nodes.length && nodes.every(node => nonempty(node.id)
          && nonempty(node.label) && [...node.label].length <= 40),
        `${at}.diagram node IDs must be unique and labels 1–40 characters`);
        check(Array.isArray(visual.edges) && visual.edges.length >= 1 && visual.edges.length <= 8,
          `${at}.diagram needs 1–8 edges`);
        check(list(visual.edges).every(edge => ids.has(edge.from) && ids.has(edge.to)
          && edge.from !== edge.to), `${at}.diagram edges must join distinct known nodes`);
      }
      if (visual.type === 'image') {
        check(nonempty(visual.path), `${at}.visual.path is required`);
        check(!visual.path || (!path.isAbsolute(visual.path)
          && !/^(?:[A-Za-z]:|https?:|data:)/.test(visual.path)
          && !visual.path.includes('\\') && !visual.path.split('/').includes('..')),
        `${at}.visual.path must stay inside baseDir and use a relative portable path`);
        check(nonempty(visual.alt), `${at}.visual.alt is required`);
        check(['design', 'source'].includes(visual.role), `${at}.visual.role must be design or source`);
        if (visual.role === 'design') {
          check(['ai-generated', 'original-design'].includes(visual.provenance?.kind)
            && nonempty(visual.provenance?.source) && nonempty(visual.provenance?.license),
          `${at} design images need honest provenance (kind, source and license)`);
        }
        if (visual.role === 'source') {
          verifyIds(visual.sourceIds, `${at}.source image`);
          check(knownReuseLicense(visual.license, visual.permission),
            `${at} source-image license or documented permission is required`);
          check(card.statementType === 'evidence',
            `${at} source figures require independently checked figure evidence`);
          check(list(card._reviewedClaims).some(claim => claim.type === 'figure'
            && imageSignature(claim.visual) === imageSignature(visual)),
          `${at} source figure and reuse license must match an independently reviewed figure claim`);
        }
      }
      if (visual.type === 'bar') {
        check(visual.dataChecked === true,
          `${at} native data charts require dataChecked:true; metadata verification is insufficient`);
        check(card.statementType === 'evidence', `${at} real-data bars must have checked evidence`);
        verifyIds(visual.sourceIds, `${at}.bar`);
        check(list(card._reviewedClaims).some(claim => claim.visual?.dataChecked === true
          && chartDataSignature(claim.visual) === chartDataSignature(visual)),
        `${at}.bar data must match the independently reviewed claim.visual data`);
        check(nonempty(visual.locator), `${at}.bar needs a source locator`);
        check(nonempty(visual.unit), `${at}.bar needs an explicit unit`);
        check(Array.isArray(visual.categories) && visual.categories.length >= 1
          && visual.categories.length <= 6 && visual.categories.every(nonempty),
        `${at}.bar categories must contain 1–6 named categories`);
        check(Array.isArray(visual.series) && visual.series.length >= 1 && visual.series.length <= 3,
          `${at}.bar needs 1–3 series`);
        list(visual.series).forEach((series, di) => {
          check(nonempty(series.name), `${at}.bar.series[${di}].name is required`);
          check(Array.isArray(series.values) && series.values.length === list(visual.categories).length
            && series.values.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0),
          `${at}.bar.series[${di}] values must match categories and be finite nonnegative numbers`);
        });
        check(visual.axis?.min === undefined || visual.axis.min === 0,
          `${at}.bar must use a zero baseline`);
        if (visual.axis?.max !== undefined) {
          check(Number.isFinite(visual.axis.max) && visual.axis.max > 0,
            `${at}.bar.axis.max must be positive`);
          check(list(visual.series).every(series => list(series.values).every(x => x <= visual.axis.max)),
            `${at}.bar.axis.max cannot clip data`);
        }
      }
      delete card._reviewedClaims;
    });
  });
  check(counts.background === 1, 'exactly one background slide is required');
  check(proposal ? counts.research === 3 : counts.research >= 1 && counts.research <= 2,
    proposal ? 'proposal requires three research slides' : 'one or two research slides are required');
  if (proposal) {
    check(counts.question === 1, 'proposal requires one scientific question slide');
    check(counts.preliminary <= 2, 'proposal allows at most two preliminary slides');
    check(slides.filter(slide => slide.kind !== 'preliminary').map(slide => slide.kind).join(',')
      === 'background,question,research,research,research,plan,references',
    'proposal order must be background, question, research ×3, plan, references');
    check(slides.every((slide, index) => slide.kind !== 'preliminary'
      || (index >= 2 && index < slides.length - 2)),
    'preliminary evidence belongs between the question and the plan');
  }
  check(counts.plan === 1, 'exactly one plan slide is required');
  check(counts.references === 1, 'exactly one references slide is required');
  check(refs.length <= 12, 'use ≤12 references for the single references slide');
  if (issues.length) throw new SpecValidationError(issues);
  return spec;
}

export const assertSpec = validateSpec;

