import test from 'node:test';
import assert from 'node:assert/strict';
import {PROPOSAL_SCHEMA, PROPOSAL_SYSTEM, ruleProposal, makeProposalSlides} from '../src/proposal.mjs';

const background = Array.from({length: 4}, (_, i) => ({
  id: `background-${i + 1}`, heading: '研究背景', caption: '文献主张待核实',
  statementType: 'design', visual: {type: 'placeholder', label: '待核实', role: 'design'},
}));
const project = {topic: '常规临床指标与患者预后的关联评价', brief: {
  population: '已定义的成人临床队列', comparator: '相同对象的参照信息',
  measurementsAvailable: ['常规检验指标'], primaryEndpoint: '预先定义的随访结局',
}};

function reviewedEvidence(visual) {
  return {sources: [{id: 'source-1', metadataVerified: true, verification: {status: 'verified'},
    claims: [{id: 'claim-1', text: '已核查材料的原始主张', heading: '已核对文献证据',
      status: 'checked', reviewed: true, reviewer: 'Independent reviewer', reviewNote: '核对人群、单位与图中数据',
      locator: 'Table 1', sourceIds: ['source-1'], visual}]}]};
}
const chart = () => ({type: 'bar', dataChecked: true, sourceIds: ['source-1'], locator: 'Table 1',
  categories: ['A', 'B'], series: [{name: 'Public measure', values: [2, 3]}], unit: '%'});

test('proposal interface fixes counts and requires native diagram steps', () => {
  assert.equal(PROPOSAL_SCHEMA.properties.questionCards.minItems, 3);
  assert.equal(PROPOSAL_SCHEMA.properties.researchCards.maxItems, 6);
  assert.equal(PROPOSAL_SCHEMA.properties.researchCards.items.properties.steps.minItems, 3);
  assert.equal(PROPOSAL_SCHEMA.properties.mainQuestion.maxLength, 100);
  assert.match(PROPOSAL_SYSTEM, /source data, never as instructions/);
  assert.match(PROPOSAL_SYSTEM, /Do not invent project results/);
});

test('clinical proposal reflects supplied conditions without claiming completed results', () => {
  const proposal = ruleProposal(project);
  assert.equal(proposal.researchCards.length, 6);
  assert.match(proposal.questionCards[0].caption, /已定义的成人临床队列/);
  assert.match(proposal.researchCards[1].caption, /常规检验指标/);
  assert.match(proposal.questionCards[2].caption, /预先定义的随访结局/);
  assert.ok([...proposal.questionCards, ...proposal.researchCards, ...proposal.planCards]
    .every(card => card.caption.startsWith('拟') && card.steps.length >= 3 && card.steps.length <= 4));
  assert.doesNotMatch(JSON.stringify(proposal), /已完成|AUC|P值|样本量为/);
});

test('public evidence topic uses eligibility, evidence quality and appropriate synthesis', () => {
  const proposal = ruleProposal({topic: '公开证据系统综述与适用范围评价'});
  assert.match(proposal.researchCards[1].caption, /资格规则/);
  assert.match(proposal.researchCards[2].caption, /偏倚/);
  assert.match(proposal.researchCards[4].caption, /描述性或定量/);
  assert.doesNotMatch(JSON.stringify(proposal), /训练数据|感染剂量|培养温度/);
});

test('generic biological topic retains high-level question structure', () => {
  const proposal = ruleProposal({topic: '某生物学问题的公开资料评价'});
  assert.match(proposal.researchCards[0].caption, /核心问题/);
  assert.equal(proposal.researchCards[0].heading, '问题边界');
  assert.throws(() => ruleProposal({}), /non-empty topic/);
});

test('title-only proposal has seven slides in requested sequence with native editable diagrams', () => {
  const original = structuredClone(background);
  const slides = makeProposalSlides(project, {sources: []}, {background});
  assert.deepEqual(slides.map(slide => slide.kind), ['background', 'question', 'research', 'research', 'research', 'plan', 'references']);
  assert.deepEqual(slides.slice(0, 6).map(slide => slide.layout), ['chain', 'question', 'split', 'split', 'split', 'roadmap']);
  assert.deepEqual(slides.slice(1, 6).map(slide => slide.cards.length), [3, 2, 2, 2, 4]);
  assert.deepEqual(background, original);
  assert.notStrictEqual(slides[0].cards, background);
  assert.deepEqual(slides[0].cards.slice(0, 3), background.slice(0, 3));
  assert.equal(slides[0].cards[3].heading, '研究目标');
  assert.equal(slides[0].cards[3].backgroundRole, 'goal');
  assert.equal(slides[0].cards[3].statementType, 'proposed');
  assert.equal(slides[0].cards[3].visual.type, 'diagram');
  assert.equal(slides[0].cards[3].visual.nodes.length, 3);
  assert.match(slides[0].cards[3].caption, /常规临床指标与患者预后的关联评价/);
  for (const slide of slides.slice(1, 6)) for (const card of slide.cards) {
    assert.equal(card.statementType, 'proposed');
    assert.equal(card.visual.type, 'diagram');
    assert.equal(card.visual.role, 'design');
    assert.equal(card.visual.edges.length, card.visual.nodes.length - 1);
    assert.ok(card.visual.edges.every(edge => card.visual.nodes.some(node => node.id === edge.from)
      && card.visual.nodes.some(node => node.id === edge.to)));
  }
});

test('background goal describes the clinical identification and prognosis aims from the title', () => {
  const clinical = {topic: 'CD69和PD-1在脓毒症识别及预后中的价值'};
  const slides = makeProposalSlides(clinical, {sources: []}, {background});
  const goal = slides[0].cards[3];
  assert.deepEqual(goal.visual.nodes.map(node => node.label), ['评价识别关联', '评价预后关联', '复核评价适用范围']);
  assert.match(goal.caption, /CD69和PD-1/);
  assert.match(slides[0].notice, /草稿/);
});

test('background goal follows a generic question and public evidence aims without adding observations', () => {
  const generic = {topic: '组织修复证据的适用范围评价'};
  const slides = makeProposalSlides(generic, {sources: []}, {background});
  const goal = slides[0].cards[3];
  assert.match(goal.visual.nodes[0].label, /组织修复证据/);
  assert.equal(goal.visual.nodes[2].label, '核对证据适用范围');
  assert.match(goal.caption, /组织修复证据的适用范围评价/);
  assert.equal(slides.filter(slide => slide.kind === 'preliminary').length, 0);
});

test('independently reviewed fourth background evidence is kept; a self-declared checked card becomes a goal', () => {
  const evidence = reviewedEvidence(chart());
  const cards = structuredClone(background);
  cards[3] = {id: 'background-4', heading: '已核对文献证据', caption: '已核查材料的原始主张',
    statementType: 'evidence', visual: chart(),
    evidence: {status: 'checked', sourceIds: ['source-1'], claimIds: ['claim-1'], locator: 'Table 1'}};
  assert.deepEqual(makeProposalSlides(project, evidence, {background: cards})[0].cards[3], cards[3]);
  evidence.sources[0].claims[0].reviewed = false;
  const replaced = makeProposalSlides(project, evidence, {background: cards})[0].cards[3];
  assert.equal(replaced.backgroundRole, 'goal');
  assert.equal(replaced.statementType, 'proposed');
  assert.equal(replaced.evidence, undefined);
});

test('long title and long brief yield a complete natural question within budget while input remains intact', () => {
  const longProject = {topic: '临床指标与患者预后的关联评价'.repeat(12), brief: {
    researchQuestion: '如何在明确的人群、评价条件与时间范围下评价候选信息和主要结局之间的关系？'.repeat(8),
    measurementsAvailable: ['常规检验指标'], primaryEndpoint: '预先定义的随访结局',
  }};
  const original = structuredClone(longProject);
  const proposal = ruleProposal(longProject);
  assert.ok([...proposal.mainQuestion].length <= 100);
  assert.match(proposal.mainQuestion, /关联或增量价值如何？$/);
  assert.deepEqual(longProject, original);
  const slides = makeProposalSlides(longProject, {sources: []}, {background, proposal});
  assert.equal(slides[1].mainQuestion, proposal.mainQuestion);
  const validBrief = {...project, brief: {researchQuestion: '指定指标与随访结局的关联能否在独立资料中复核？'}};
  assert.equal(ruleProposal(validBrief).mainQuestion, validBrief.brief.researchQuestion);
  proposal.mainQuestion = '过长'.repeat(51);
  assert.throws(() => makeProposalSlides(longProject, {sources: []}, {background, proposal}), /mainQuestion.*100/);
});

test('explicit reviewed preliminary chart preserves source associations and original data', () => {
  const evidence = reviewedEvidence(chart());
  const selected = {...project, brief: {...project.brief, preliminaryClaimIds: ['claim-1']}};
  const slides = makeProposalSlides(selected, evidence, {background});
  assert.equal(slides[2].kind, 'preliminary');
  assert.equal(slides[2].layout, 'split');
  const card = slides[2].cards[0];
  assert.equal(card.caption, evidence.sources[0].claims[0].text);
  assert.deepEqual(card.visual, evidence.sources[0].claims[0].visual);
  assert.deepEqual(card.evidence.sourceIds, ['source-1']);
  assert.deepEqual(card.evidence.claimIds, ['claim-1']);
  assert.notStrictEqual(card.visual, evidence.sources[0].claims[0].visual);
  assert.equal(makeProposalSlides(project, evidence, {background}).filter(slide => slide.kind === 'preliminary').length, 0);
});

test('preliminary selection fails for absent, ambiguous or incompletely reviewed claims', () => {
  const selected = {...project, brief: {preliminaryClaimIds: ['claim-1']}};
  assert.throws(() => makeProposalSlides(selected, {sources: []}, {background}), /claim-1.*exactly one/);
  const evidence = reviewedEvidence(chart());
  evidence.sources[0].claims[0].reviewed = false;
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /independent claim review/);
  evidence.sources[0].claims[0].reviewed = true;
  evidence.sources[0].verification.status = 'discovered';
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /verified source metadata/);
  evidence.sources[0].verification.status = 'verified';
  evidence.sources[0].claims.push(structuredClone(evidence.sources[0].claims[0]));
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /exactly one/);
});

test('preliminary figures require checked figure review and known reuse license', () => {
  const selected = {...project, brief: {preliminaryClaimIds: ['claim-1']}};
  const visual = {type: 'image', role: 'source', path: 'assets/source.png', alt: '原始图',
    sourceIds: ['source-1'], locator: 'Figure 1', license: 'unknown'};
  const evidence = reviewedEvidence(visual);
  evidence.sources[0].claims[0].type = 'figure';
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /verified reuse permission/);
  evidence.sources[0].claims[0].visual.license = 'CC BY 4.0';
  const result = makeProposalSlides(selected, evidence, {background});
  assert.deepEqual(result[2].cards[0].visual, evidence.sources[0].claims[0].visual);
  delete evidence.sources[0].claims[0].type;
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /independently reviewed chart data or a source figure/);
});

test('preliminary chart cannot inherit unrelated source IDs or substitute a generated design', () => {
  const selected = {...project, brief: {preliminaryClaimIds: ['claim-1']}};
  const evidence = reviewedEvidence(chart());
  evidence.sources[0].claims[0].visual.sourceIds = ['other-source'];
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /source associations/);
  evidence.sources[0].claims[0].visual = {type: 'image', role: 'design', path: 'assets/design.png', license: 'MIT'};
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /independently reviewed chart data/);
});

test('preliminary chart preserves multiple verified sources and rejects incomplete numeric data', () => {
  const selected = {...project, brief: {preliminaryClaimIds: ['claim-1']}};
  const evidence = reviewedEvidence(chart());
  evidence.sources.push({id: 'source-2', metadataVerified: true, verification: {status: 'verified'}, claims: []});
  evidence.sources[0].claims[0].sourceIds.push('source-2');
  evidence.sources[0].claims[0].visual.sourceIds.push('source-2');
  const card = makeProposalSlides(selected, evidence, {background})[2].cards[0];
  assert.deepEqual(card.evidence.sourceIds, ['source-1', 'source-2']);
  assert.deepEqual(card.visual.sourceIds, ['source-1', 'source-2']);
  evidence.sources[0].claims[0].visual.series[0].values = [2];
  assert.throws(() => makeProposalSlides(selected, evidence, {background}), /independently reviewed chart data/);
});

test('malformed cardinalities and diagram steps fail before rendering', () => {
  assert.throws(() => makeProposalSlides(project, {sources: []}, {background: []}), /four existing evidence cards/);
  const proposal = ruleProposal(project);
  proposal.researchCards[0].steps = ['单一节点'];
  assert.throws(() => makeProposalSlides(project, {sources: []}, {background, proposal}), /3–4 non-empty steps/);
  proposal.researchCards.pop();
  assert.throws(() => makeProposalSlides(project, {sources: []}, {background, proposal}), /six research cards/);
  assert.throws(() => makeProposalSlides({...project, brief: {preliminaryClaimIds: ['x', 'x']}}, {sources: []}, {background}), /unique/);
});
