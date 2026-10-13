#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createProject,assertProject,readJson,writeJson,copySpecAssets,researchProject,planProject,generateImages,buildPresentation,validateWorkflowSpec,runProject,demoProject,WorkflowError} from './src/workflow.mjs';

const HELP=`research-slides — evidence-aware scientific PPTX workflow

  create "研究题目" [--template proposal|compact] [--dir runs/my-study]
         [--brief brief.json] [--query "PubMed expression"] [--evidence reviewed.json]
         [--provider rules|openai] [--mode native|openai] [--offline]
  init --topic "研究题目" [--query "English PubMed expression"] [--out project.json]
       [--brief brief.json|brief.txt] [--figure-count 7|8] [--config provider.json]
       [--provider rules|openai] [--mode native|openai] [--template compact|proposal]
  research project.json [--out evidence.json]
  plan project.json [--evidence evidence.json] [--provider rules|openai] [--out spec.json]
  images spec.json [--project project.json] [--mode native|openai] [--out spec.images.json]
  build spec.json [--out research.pptx] [--final]
  run project.json [--evidence reviewed-evidence.json] [--spec edited-spec.json]
      [--provider rules|openai] [--mode native|openai] [--out research.pptx] [--final] [--offline]
  demo [--dir build/demo] [--template compact|proposal] [--example natural-antiviral|sepsis] [--final]
  validate spec.json [--final]

Only independently reviewed, traceable claims can be background evidence.
Unreviewed background content is visibly marked as a draft. --final blocks it.
OpenAI keys are read only from the configured environment variable.
OpenAI image calls may incur charges; native mode and demo make no paid calls.
create defaults to the 7-slide proposal framework. Without --query, --evidence
or --provider openai it creates an offline structural draft with pending evidence.
`;

function args(values) {
  const positionals=[],flags={};
  const boolean=new Set(['final','help','offline']);
  const supported=new Set(['topic','query','out','dir','brief','figure-count','config','evidence','spec','provider','project','mode','template','example','offline','final','help']);
  for (let i=0;i<values.length;i++) {
    const token=values[i];
    if (!token.startsWith('--')) {positionals.push(token);continue;}
    const key=token.slice(2);
    if (!supported.has(key)) throw new WorkflowError(`Unknown option: ${token}`);
    if (boolean.has(key)) {flags[key]=true;continue;}
    const value=values[++i];
    if (!value||value.startsWith('--')) throw new WorkflowError(`Missing value for --${key}`);
    flags[key]=value;
  }
  return {positionals,flags};
}

function required(value,name) {if (!value) throw new WorkflowError(`Missing ${name}. Run --help for usage.`);return value;}
function outputDir(filename,project) {return path.resolve(path.dirname(path.resolve(filename)),project.outputDir||'output');}
function show(value) {console.log(JSON.stringify(value,null,2));}

async function projectFromFlags(topic,flags,template) {
  let brief=null;
  if (flags.brief) {const text=await fs.readFile(flags.brief,'utf8');brief=flags.brief.endsWith('.json')?JSON.parse(text):text;}
  const project=createProject(required(topic,'research topic'),{query:flags.query,brief,
    figureCount:flags['figure-count']||8,template:flags.template||template});
  if (flags.config) project.provider={...project.provider,...await readJson(flags.config)};
  if (flags.provider) project.provider.planner=flags.provider;
  if (flags.mode) project.design.imageMode=flags.mode;
  return assertProject(project);
}

async function main() {
  const [command,...rest]=process.argv.slice(2),{positionals,flags}=args(rest);
  if (!command||command==='--help'||command==='help'||flags.help) {console.log(HELP);return;}
  const input=positionals[0];
  if (command==='create') {
    const project=await projectFromFlags(flags.topic||input,flags,'proposal');
    const hash=createHash('sha256').update(project.topic).digest('hex').slice(0,10);
    const dir=path.resolve(flags.dir||path.join('runs',`study-${hash}`)),filename=path.join(dir,'project.json');
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(filename,JSON.stringify(project,null,2)+'\n',{flag:'wx'}).catch(error=>{
      if (error.code==='EEXIST') throw new WorkflowError(`Project already exists: ${filename}. Resume it with run; existing edits were preserved.`);
      throw error;
    });
    const offline=Boolean(flags.offline||(!flags.query&&!flags.evidence&&project.provider.planner==='rules'));
    show(await runProject(filename,{evidencePath:flags.evidence,provider:flags.provider,
      imageMode:flags.mode,outputPath:flags.out?path.resolve(flags.out):undefined,final:flags.final,
      offline,onProgress:message=>console.error(message)}));return;
  }
  if (command==='init') {
    const project=await projectFromFlags(required(flags.topic,'--topic'),flags,'compact');
    const filename=path.resolve(flags.out||path.join(flags.dir||'.','project.json'));
    await writeJson(filename,project);show({project:filename,notice:'Research and plans will remain proposed; final background claims require independent review.'});return;
  }
  if (command==='research') {
    const filename=path.resolve(required(input,'project.json')),project=await readJson(filename);
    const evidence=await researchProject(project);
    const destination=flags.out||path.join(outputDir(filename,project),'evidence.json');await writeJson(destination,evidence);
    show({evidence:path.resolve(destination),sourceCount:evidence.sources.length,warnings:evidence.warnings,notice:evidence.notice});return;
  }
  if (command==='plan') {
    const filename=path.resolve(required(input,'project.json')),project=await readJson(filename),baseDir=outputDir(filename,project);
    const evidencePath=flags.evidence||path.join(baseDir,'evidence.json');
    const {spec,evidence}=await planProject(project,await readJson(evidencePath),{provider:flags.provider});
    const destination=flags.out||path.join(baseDir,'spec.json');
    await copySpecAssets(spec,path.dirname(path.resolve(evidencePath)),path.dirname(path.resolve(destination)));
    await writeJson(destination,spec);
    await writeJson(path.join(path.dirname(path.resolve(destination)),'evidence.planned.json'),evidence);
    show({spec:path.resolve(destination),status:spec.workflow.status,figureCount:spec.workflow.figureCount,notice:spec.workflow.status==='draft'?'文献主张待核实；可构建明显标注的草稿，最终版需要独立核查。':'Background claims have documented independent review.'});return;
  }
  if (command==='images') {
    const filename=path.resolve(required(input,'spec.json')),spec=await readJson(filename),baseDir=path.dirname(filename);
    const project=flags.project?await readJson(flags.project):createProject(spec.title||'Scientific research');
    if ((flags.mode||project.design.imageMode)==='openai') console.error('Generating prespecified design images with the configured API; usage charges may apply.');
    const result=await generateImages(spec,project,{baseDir,mode:flags.mode});
    const destination=flags.out||path.join(baseDir,'spec.images.json');await writeJson(destination,result.spec);
    show({spec:path.resolve(destination),images:result.generated,notice:result.notice});return;
  }
  if (command==='build') {
    const filename=path.resolve(required(input,'spec.json')),baseDir=path.dirname(filename);
    show(await buildPresentation(await readJson(filename),{baseDir,outputPath:path.resolve(flags.out||path.join(baseDir,'research.pptx')),final:flags.final}));return;
  }
  if (command==='run') {
    show(await runProject(required(input,'project.json'),{evidencePath:flags.evidence,specPath:flags.spec,provider:flags.provider,imageMode:flags.mode,outputPath:flags.out?path.resolve(flags.out):undefined,final:flags.final,offline:flags.offline,onProgress:message=>console.error(message)}));return;
  }
  if (command==='demo') {show(await demoProject({outputDir:flags.dir?path.resolve(flags.dir):undefined,final:flags.final,template:flags.template,example:flags.example}));return;}
  if (command==='validate') {
    const result=await validateWorkflowSpec(await readJson(required(input,'spec.json')),{final:flags.final});
    show({valid:true,publishable:result.publishable,warnings:result.warnings});return;
  }
  throw new WorkflowError(`Unknown command: ${command}`);
}

main().catch(error=>{console.error(`${error.name||'Error'}: ${error.message}`);for (const issue of error.issues||[]) console.error(`- ${issue}`);process.exitCode=1;});
