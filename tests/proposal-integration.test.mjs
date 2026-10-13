import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createProject,planProject,validateWorkflowSpec,runProject,writeJson} from '../src/workflow.mjs';
import {validateSpec} from '../src/schema.mjs';
import {ruleProposal,PROPOSAL_SCHEMA} from '../src/proposal.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const project=()=>createProject('常规检验与免疫指标的预后价值',{template:'proposal'});

test('proposal planner integrates a title-aware goal and preserves seven-slide order',async()=>{
  const {spec}=await planProject(project(),{sources:[]});
  assert.equal(spec.template,'proposal');
  assert.deepEqual(spec.slides.map(slide=>slide.kind),['background','question','research','research','research','plan','references']);
  assert.equal(spec.slides[0].cards[3].backgroundRole,'goal');
  assert.equal(spec.slides[0].cards[3].statementType,'proposed');
  assert.equal((await validateWorkflowSpec(spec)).warnings.length,3);
  await assert.rejects(validateWorkflowSpec(spec,{final:true}),/validation failed/);
});

test('native diagrams reject dangling edges, duplicate IDs and evidence impersonation',async()=>{
  const {spec}=await planProject(project(),{sources:[]});
  for(const mutate of [
    card=>{card.visual.edges[0].to='missing';},
    card=>{card.visual.nodes[1].id=card.visual.nodes[0].id;},
    card=>{card.statementType='pending';},
  ]) {
    const bad=structuredClone(spec);mutate(bad.slides[1].cards[0]);
    assert.throws(()=>validateSpec(bad),/Invalid slide specification/);
  }
  const order=structuredClone(spec);[order.slides[0],order.slides[1]]=[order.slides[1],order.slides[0]];
  assert.throws(()=>validateSpec(order),/proposal order/);
});

test('proposed objective cannot certify an empirical background slot',async()=>{
  const {spec}=await planProject(project(),{sources:[]});
  const fake=structuredClone(spec.slides[0].cards[3]);fake.id='fake-goal';
  spec.slides[0].cards[0]=fake;
  const checked=await validateWorkflowSpec(spec);
  assert.equal(checked.warnings.length,3);
  await assert.rejects(validateWorkflowSpec(spec,{final:true}),/validation failed/);
});

test('OpenAI proposal uses the dedicated schema and does not promote evidence',async()=>{
  const p=project();let request;
  const {spec}=await planProject(p,{sources:[]},{provider:'openai',env:{OPENAI_API_KEY:'mock-key'},
    fetchImpl:async(_url,options)=>{
      request=JSON.parse(options.body);
      return {ok:true,json:async()=>({status:'completed',output_text:JSON.stringify(ruleProposal(p))})};
    }});
  assert.deepEqual(request.text.format.schema,PROPOSAL_SCHEMA);
  assert.equal(spec.workflow.status,'draft');
  assert.ok(spec.slides.filter(slide=>slide.kind==='research').flatMap(slide=>slide.cards)
    .every(card=>card.statementType==='proposed'));
  assert.equal(spec.references.length,0);
});

test('one-command title input writes a real proposal and refuses to overwrite a saved project',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'proposal-cli-'));
  const title='公开证据评价：$(never-execute)';
  try {
    const output=execFileSync(process.execPath,[path.join(root,'cli.mjs'),'create',title,'--dir',dir],
      {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const result=JSON.parse(output),spec=JSON.parse(await fs.readFile(result.specPath,'utf8'));
    assert.equal(result.slideCount,7);assert.equal(spec.title,title);
    assert.equal(spec.template,'proposal');
    const bytes=await fs.readFile(result.outputPath);assert.equal(bytes.subarray(0,2).toString(),'PK');
    assert.ok(result.warnings.some(warning=>warning.includes('离线')));
    const before=await fs.readFile(path.join(dir,'project.json'),'utf8');
    assert.throws(()=>execFileSync(process.execPath,[path.join(root,'cli.mjs'),'create','different title','--dir',dir],
      {encoding:'utf8',stdio:['ignore','pipe','pipe']}),error=>error.stderr.includes('existing edits were preserved'));
    assert.equal(await fs.readFile(path.join(dir,'project.json'),'utf8'),before);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('resume rejects a different template without replacing existing edits',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'proposal-template-'));
  try {
    const p=project(),old=await planProject(createProject(p.topic),{sources:[]});
    const filename=path.join(dir,'project.json'),specFile=path.join(dir,'output','spec.json');
    await writeJson(filename,p);await writeJson(path.join(dir,'output','evidence.json'),{sources:[]});
    await writeJson(specFile,old.spec);const before=await fs.readFile(specFile,'utf8');
    await assert.rejects(runProject(filename),/different template/);
    assert.equal(await fs.readFile(specFile,'utf8'),before);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('a changed topic or planner cannot silently reuse an old proposal',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'proposal-resume-'));
  try {
    const p=project(),{spec}=await planProject(p,{sources:[]}),filename=path.join(dir,'project.json');
    await writeJson(path.join(dir,'output','spec.json'),spec);
    await writeJson(path.join(dir,'output','evidence.json'),{sources:[],offline:true});
    await writeJson(filename,{...p,topic:'A different public evidence question'});
    await assert.rejects(runProject(filename),/different topic/);
    await writeJson(filename,p);
    await assert.rejects(runProject(filename,{provider:'openai'}),/different planner/);
    p.literature.query='sepsis biomarkers';await writeJson(filename,p);
    await assert.rejects(runProject(filename),/offline draft/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('a chart footnote cannot alter an independently reviewed statistical meaning',async()=>{
  const spec=JSON.parse(await fs.readFile(path.join(root,'examples/proposal/spec.json'),'utf8'));
  spec.slides[0].cards[2].visual.footnote='This proves validated incremental prediction.';
  await assert.rejects(validateWorkflowSpec(spec,{final:true}),/Invalid slide specification/);
});

test('imported reviewed figures resolve relative to their evidence file in run and plan',async()=>{
  // Synthetic contract fixture; not a real scientific paper or empirical figure.
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'proposal-figure-import-'));
  try {
    const visual={type:'image',role:'source',path:'assets/figure.png',alt:'Contract fixture',
      sourceIds:['fixture'],locator:'Synthetic fixture',license:'CC0'};
    const claim={id:'fixture-figure',heading:'Contract figure',text:'Synthetic contract fixture',
      type:'figure',status:'checked',reviewed:true,reviewer:'test fixture',
      reviewNote:'Synthetic API contract record, not research evidence.',locator:'Synthetic fixture',
      sourceIds:['fixture'],backgroundRole:'problem',visual};
    const evidence={sources:[{id:'fixture',title:'Synthetic source',year:2020,
      url:'https://example.test/source',metadataVerified:true,verification:{status:'verified'},claims:[claim]}]};
    const evidencePath=path.join(dir,'reviewed','evidence.json');
    await writeJson(evidencePath,evidence);await fs.mkdir(path.join(dir,'reviewed','assets'));
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lUQAAAAASUVORK5CYII=','base64');
    await fs.writeFile(path.join(dir,'reviewed','assets','figure.png'),image);
    const p=project();p.brief={preliminaryClaimIds:['fixture-figure']};
    const filename=path.join(dir,'study','project.json');await writeJson(filename,p);
    const result=await runProject(filename,{evidencePath});
    assert.equal(result.slideCount,8);
    assert.deepEqual(await fs.readFile(path.join(dir,'study','output','assets','figure.png')),image);
    const planned=path.join(dir,'another-plan','spec.json');
    execFileSync(process.execPath,[path.join(root,'cli.mjs'),'plan',filename,'--evidence',evidencePath,'--out',planned],
      {encoding:'utf8',stdio:['ignore','pipe','pipe']});
    assert.deepEqual(await fs.readFile(path.join(dir,'another-plan','assets','figure.png')),image);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
