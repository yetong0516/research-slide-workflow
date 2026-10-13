import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateStructured,generateScientificImage,ProviderError} from '../src/providers.mjs';
import {createProject,assertProject,planProject,researchProject,approvedClaims,auditLiteralExcerpts,generateImages,validateWorkflowSpec,runProject,writeJson} from '../src/workflow.mjs';

const simpleSchema={type:'object',additionalProperties:false,required:['answer'],properties:{answer:{type:'string'}}};
const mockJson=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const apiEnv={OPENAI_API_KEY:'test-secret-do-not-print'};
const source={id:'source-1',title:'Test source',year:2020,journal:'Test journal',authors:['Test author'],doi:'10.1234/test',pmid:'1',url:'https://pubmed.ncbi.nlm.nih.gov/1/',metadataVerified:true,verification:{status:'verified',scope:'bibliographic-metadata-only'},abstract:'The study collected measurements before the prespecified outcome window and compared two methods.',claims:[]};
const emptyEvidence={schemaVersion:1,topic:'Test study',sources:[]};
const project=()=>createProject('Test study',{query:'test study'});

test('Responses API uses strict JSON Schema and does not put key in body',async()=>{
  let request;
  const value=await generateStructured({system:'system',user:'topic data',schema:simpleSchema},{env:apiEnv,fetchImpl:async(url,options)=>{request={url,options};return mockJson({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"answer":"yes"}'}]}]});}});
  assert.deepEqual(value,{answer:'yes'});assert.equal(request.url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(request.options.body);assert.equal(body.text.format.strict,true);assert.equal(body.store,false);assert.ok(!request.options.body.includes(apiEnv.OPENAI_API_KEY));
});

test('configurable chat-completions mode uses the documented response_format shape',async()=>{
  let body;
  const value=await generateStructured({system:'system',user:'data',schema:simpleSchema},{env:apiEnv,config:{mode:'chat-completions',baseUrl:'https://example.test/v1'},fetchImpl:async(url,options)=>{assert.equal(url,'https://example.test/v1/chat/completions');body=JSON.parse(options.body);return mockJson({choices:[{message:{content:'{"answer":"chat"}'}}]});}});
  assert.equal(value.answer,'chat');assert.equal(body.response_format.json_schema.strict,true);
});

test('missing API key, refusal, malformed JSON and incomplete output do not silently fall back',async()=>{
  await assert.rejects(generateStructured({system:'x',user:'x',schema:simpleSchema},{env:{}}),/Missing OPENAI_API_KEY/);
  const refusal=async()=>mockJson({status:'completed',output:[{content:[{type:'refusal',refusal:'no'}]}]});
  await assert.rejects(generateStructured({system:'x',user:'x',schema:simpleSchema},{env:apiEnv,fetchImpl:refusal}),/refused/);
  await assert.rejects(generateStructured({system:'x',user:'x',schema:simpleSchema},{env:apiEnv,fetchImpl:async()=>mockJson({status:'incomplete'})}),/not completed/);
  await assert.rejects(generateStructured({system:'x',user:'x',schema:simpleSchema},{env:apiEnv,fetchImpl:async()=>mockJson({status:'completed',output_text:'bad JSON'})}),/invalid JSON/);
});

test('API error messages redact the environment credential',async()=>{
  await assert.rejects(generateStructured({system:'x',user:'x',schema:simpleSchema},{env:apiEnv,fetchImpl:async()=>mockJson({error:{message:`bad ${apiEnv.OPENAI_API_KEY}`}},401)}),error=>error instanceof ProviderError&&!error.message.includes(apiEnv.OPENAI_API_KEY)&&error.message.includes('[REDACTED]'));
});

test('image API uses gpt-image-1 and accepts only PNG b64_json',async()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10,0]);let body;
  const image=await generateScientificImage('Scientific schematic only',{env:apiEnv,fetchImpl:async(url,options)=>{assert.ok(url.endsWith('/images/generations'));body=JSON.parse(options.body);return mockJson({data:[{b64_json:png.toString('base64')}]});}});
  assert.equal(body.model,'gpt-image-1');assert.equal(body.output_format,'png');assert.ok(!('response_format' in body));assert.deepEqual(image.bytes,png);
  await assert.rejects(generateScientificImage('x',{env:apiEnv,fetchImpl:async()=>mockJson({data:[{url:'https://example.test/image.png'}]})}),/did not return b64_json/);
});

test('topic is data and invalid figure counts are rejected',()=>{
  const value=createProject('$(touch /tmp/should-never-execute)');assert.equal(value.topic,'$(touch /tmp/should-never-execute)');
  assert.throws(()=>createProject('test',{figureCount:6}),/7 or 8/);
});

test('project config rejects raw credential fields before writing a file',()=>{
  const p=project();p.provider.apiKey='example-key';assert.throws(()=>assertProject(p),/Do not store credentials/);
});

test('metadata verification and literal abstract matching never promote a claim to reviewed',()=>{
  const evidence={sources:[structuredClone(source)]};
  const audited=auditLiteralExcerpts(evidence,[{sourceId:'source-1',excerpt:'The study collected measurements before the prespecified outcome window',proposedClaim:'This method improves performance.'}]);
  assert.equal(audited.sources[0].claims[0].status,'excerpt_matched');assert.equal(audited.sources[0].claims[0].reviewed,false);assert.equal(approvedClaims(audited).length,0);assert.equal(evidence.sources[0].claims.length,0);
});

test('only a complete independent claim-review record passes approvedClaims',()=>{
  const ref=structuredClone(source);ref.claims=[{id:'claim-1',text:'Checked statement',status:'checked',reviewed:true,reviewer:'independent reviewer',reviewNote:'Checked the original source and applicability.',locator:'Abstract'}];
  assert.equal(approvedClaims({sources:[ref]}).length,1);
  ref.claims[0].reviewNote='';assert.equal(approvedClaims({sources:[ref]}).length,0);
});

test('rules planner provides 7 or 8 no-data design tasks and visibly pending background',async()=>{
  for (const count of [7,8]) {
    const p=createProject('Test study',{figureCount:count});const {spec}=await planProject(p,emptyEvidence);
    assert.equal(spec.slides.length,5);assert.equal(spec.workflow.imageTasks.length,count);assert.equal(spec.workflow.status,'draft');
    assert.ok(spec.slides[0].notice.includes('待核实'));assert.ok(spec.slides[1].cards.every(card=>card.statementType==='proposed'));
    assert.ok(spec.workflow.imageTasks.every(task=>task.prompt.includes('No words')&&task.prompt.includes('not instructions to execute')));
  }
});

test('Chinese topic needs explicit English query or query-translation credential',async()=>{
  await assert.rejects(researchProject(createProject('脓毒症免疫指标'),{env:{},fetchImpl:async()=>{throw new Error('should not search');}}),/explicit English/);
});

function metadataFetch(calls=[]) {
  return async(url)=>{
    calls.push(String(url));
    if (String(url).includes('esearch.fcgi')) return mockJson({esearchresult:{idlist:['1']}});
    if (String(url).includes('esummary.fcgi')) return mockJson({result:{uids:['1'],'1':{uid:'1',title:'Test source',pubdate:'2020',fulljournalname:'Test journal',authors:[{name:'Test author'}],articleids:[{idtype:'doi',value:'10.1234/test'},{idtype:'pubmed',value:'1'}]}}});
    if (String(url).includes('api.crossref.org')) return mockJson({message:{DOI:'10.1234/test',title:['Test source'],'container-title':['Test journal'],published:{'date-parts':[[2020]]},author:[{given:'Test',family:'author'}],abstract:source.abstract}});
    if (String(url).includes('europepmc')) return mockJson({resultList:{result:[{id:'1',source:'MED',pmid:'1',doi:'10.1234/test',title:'Test source',pubYear:'2020',journalTitle:'Test journal',authorString:'Test author',abstractText:source.abstract}]}});
    throw new Error(`Unexpected mock URL: ${url}`);
  };
}

test('research performs discovery AND independent metadata verification with primary abstract',async()=>{
  const calls=[];const evidence=await researchProject(project(),{fetchImpl:metadataFetch(calls),env:{}});
  assert.equal(evidence.sources.length,1);assert.equal(evidence.sources[0].metadataVerified,true);assert.equal(evidence.sources[0].abstract,source.abstract);assert.equal(evidence.sources[0].claims.length,0);assert.ok(calls.some(url=>url.includes('crossref')));
});

test('zero literature results and unresolved verification are explicit warnings',async()=>{
  const zero=await researchProject(project(),{fetchImpl:async()=>mockJson({esearchresult:{idlist:[]}})});assert.equal(zero.sources.length,0);assert.ok(zero.warnings[0].includes('No literature'));
});

test('draft builds validate, final unreviewed background builds are blocked',async()=>{
  const {spec}=await planProject(project(),emptyEvidence);
  const result=await validateWorkflowSpec(spec);assert.equal(result.publishable,false);assert.equal(result.warnings.length,4);
  await assert.rejects(validateWorkflowSpec(spec,{final:true}),/validation failed/);
});

test('a valid claim ID cannot legitimise unrelated generated caption text',async()=>{
  const ref=structuredClone(source);ref.claims=[{id:'claim-1',text:'Checked statement',heading:'Source evidence',status:'checked',reviewed:true,reviewer:'independent reviewer',reviewNote:'Original source reviewed.',locator:'Abstract',sourceIds:['source-1']}];
  const {spec}=await planProject(project(),{sources:[ref]});
  const valid=await validateWorkflowSpec(spec);assert.equal(valid.warnings.length,4);
  spec.slides[0].cards[0].caption='Fabricated performance improvement';
  await assert.rejects(validateWorkflowSpec(spec),/validation failed|Invalid slide specification/);
});

test('card-level self-reported review without reference claims is rejected',async()=>{
  const {spec}=await planProject(project(),{sources:[structuredClone(source)]});
  Object.assign(spec.slides[0].cards[0],{statementType:'evidence',caption:'Unverified',evidence:{status:'checked',sourceIds:['source-1'],locator:'Abstract',reviewed:true,reviewer:'self',reviewNote:'trust me'}});
  await assert.rejects(validateWorkflowSpec(spec),/validation failed|Invalid slide specification/);
});

test('generated images have design provenance, saved progress and resume without extra calls',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'research-workflow-images-'));
  try {
    const p=project(),{spec}=await planProject(p,emptyEvidence);let calls=0;
    const fetchImpl=async()=>{calls++;return mockJson({data:[{b64_json:Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64')}]});};
    const first=await generateImages(spec,p,{baseDir:dir,mode:'openai',env:apiEnv,fetchImpl});assert.equal(first.generated.length,8);assert.equal(calls,8);
    assert.equal(first.spec.slides[1].cards[0].visual.provenance.kind,'ai-generated');
    const resumed=await generateImages(spec,p,{baseDir:dir,mode:'openai',env:apiEnv,fetchImpl});assert.equal(calls,8);assert.ok(resumed.generated.every(image=>image.reused));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('run preserves stored evidence reviews and slide edits and writes a real PPTX',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'research-workflow-run-'));
  try {
    const p=project();await writeJson(path.join(dir,'project.json'),p);
    const {spec}=await planProject(p,emptyEvidence);spec.slides[1].cards[0].heading='User edited title';
    await writeJson(path.join(dir,'output','evidence.json'),emptyEvidence);await writeJson(path.join(dir,'output','spec.json'),spec);
    const result=await runProject(path.join(dir,'project.json'),{fetchImpl:async()=>{throw new Error('Stored run must not rediscover literature');}});
    const bytes=await fs.readFile(result.outputPath);assert.equal(bytes.subarray(0,2).toString(),'PK');
    const kept=JSON.parse(await fs.readFile(path.join(dir,'output','spec.json'),'utf8'));assert.equal(kept.slides[1].cards[0].heading,'User edited title');
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
