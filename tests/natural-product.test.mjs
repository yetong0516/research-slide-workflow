import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createProject,planProject,validateWorkflowSpec,demoProject} from '../src/workflow.mjs';
import {ruleProposal} from '../src/proposal.mjs';

test('natural-product title follows extract, constituents and mechanism questions',async()=>{
  const project=createProject('植物来源天然产物抗流感研究',{template:'proposal',brief:{
    plantSource:'植物 X',extractName:'粗提物 X',candidateName:'NP',
    researchQuestion:'粗提物与NP的效应、安全性和作用解释是否一致？'}});
  const proposal=ruleProposal(project);
  assert.equal(proposal.mainQuestion,project.brief.researchQuestion);
  const text=JSON.stringify(proposal);
  for(const keyword of ['粗提物 X','NP','成分','宿主','作用','转化']) assert.ok(text.includes(keyword));
  assert.ok(!/临床基准|患者|预后|增量价值|病例/.test(text));
  const {spec}=await planProject(project,{sources:[]});
  assert.equal(spec.slides.length,7);
  assert.ok(spec.slides.filter(slide=>slide.kind==='research').flatMap(slide=>slide.cards)
    .every(card=>card.statementType==='proposed'));
});

test('natural-product systematic-review titles retain the review structure',()=>{
  const proposal=ruleProposal({topic:'植物来源天然产物抗流感的系统综述',brief:null});
  assert.ok(JSON.stringify(proposal).includes('证据质量'));
  assert.ok(!JSON.stringify(proposal).includes('粗提物候选价值'));
});

test('default demo is the natural-product example with real sources and independent images',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'natural-demo-'));
  try {
    const result=await demoProject({outputDir:dir,final:true});
    assert.equal(result.slideCount,8);assert.equal(result.publishable,true);
    const spec=JSON.parse(await fs.readFile(result.specPath,'utf8'));
    assert.match(spec.title,/植物来源天然产物/);
    assert.ok(!spec.references.some(ref=>ref.pmid==='38070793'));
    assert.deepEqual(spec.references.map(ref=>ref.id),['li2019','hayden2018','geng2020','hour2013']);
    assert.equal(spec.slides[0].cards[2].visual.role,'source');
    assert.equal(spec.slides[0].cards[2].visual.license,'CC BY 4.0');
    assert.deepEqual(spec.slides[0].cards[0].visual.series[0].values,[1.5,38.5]);
    assert.ok(spec.slides.find(slide=>slide.kind==='preliminary').notice.includes('外部文献'));
    assert.deepEqual(spec.slides.find(slide=>slide.kind==='preliminary').cards[0].visual.categories,
      ['季节性H1N1（2007）','大流行H1N1（2009）']);
    await fs.access(path.join(dir,spec.slides[0].cards[2].visual.path));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('an interval cannot acquire an invented point or changed interpretation',async()=>{
  const original=JSON.parse(await fs.readFile('examples/natural-antiviral/spec.json','utf8'));
  for(const mutate of [
    visual=>{visual.series[0].values=[1.6,39];},
    visual=>{visual.series[0].upper[1]=42;},
    visual=>{visual.intervalLabel='95%CrI';},
    visual=>{visual.axis.max=39;},
  ]) {
    const spec=structuredClone(original);mutate(spec.slides[0].cards[0].visual);
    await assert.rejects(validateWorkflowSpec(spec,{final:true}),/Invalid slide specification/);
  }
});
