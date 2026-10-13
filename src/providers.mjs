// REST shapes verified against official OpenAI documentation, 2026-10-13:
// https://developers.openai.com/api/docs/guides/structured-outputs
// https://developers.openai.com/api/reference/resources/images
// Public fetch-only implementation: no desktop runtime or private SDK required.
export const DEFAULT_PROVIDER_CONFIG = Object.freeze({
  mode: 'responses', baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY', textModel: 'gpt-4.1-mini',
  imageModel: 'gpt-image-1', timeoutMs: 120000,
  imageSize: '1536x1024', imageQuality: 'medium', imageBackground: 'opaque',
});

export class ProviderError extends Error {
  constructor(message, details={}) { super(message); this.name='ProviderError'; this.details=details; }
}

export function providerConfig(overrides={}) {
  const config={...DEFAULT_PROVIDER_CONFIG,...overrides};
  if (!['responses','chat-completions'].includes(config.mode)) throw new ProviderError(`Unsupported text API mode: ${config.mode}`);
  const url=new URL(config.baseUrl);
  if (!['https:','http:'].includes(url.protocol)) throw new ProviderError('Provider baseUrl must use HTTP or HTTPS.');
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs<=0) throw new ProviderError('Provider timeoutMs must be positive.');
  return config;
}

function keyFor(config, env) {
  const key=env[config.apiKeyEnv];
  if (!key) throw new ProviderError(`Missing ${config.apiKeyEnv}; use demo/native mode or set the key environment variable.`);
  return key;
}

function safeMessage(value,key) {
  return String(value||'Unknown error').split(key).join('[REDACTED]').slice(0,1000);
}

async function request(endpoint, body, {config,fetchImpl,env}) {
  const key=keyFor(config,env);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),config.timeoutMs);
  let response;
  try {
    response=await fetchImpl(`${config.baseUrl.replace(/\/$/,'')}/${endpoint}`,{
      method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:controller.signal,
    });
    const data=await response.json();
    if (!response.ok) throw new ProviderError(`OpenAI request failed (${response.status}): ${safeMessage(data?.error?.message,key)}`,{status:response.status,endpoint});
    return data;
  } catch(error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`OpenAI ${endpoint} request failed: ${safeMessage(error.message,key)}`,{endpoint});
  } finally { clearTimeout(timer); }
}

// A small JSON Schema validator suffices for this workflow's closed schemas.
export function assertJsonShape(value,schema,path='$') {
  const allowed=Array.isArray(schema.type)?schema.type:[schema.type];
  const actual=value===null?'null':Array.isArray(value)?'array':typeof value==='object'?'object':typeof value;
  if (schema.type && !allowed.includes(actual)) throw new ProviderError(`Structured output ${path}: expected ${allowed.join('|')}, got ${actual}`);
  if (schema.enum && !schema.enum.includes(value)) throw new ProviderError(`Structured output ${path}: unsupported value`);
  if (actual==='object') {
    for (const name of schema.required||[]) if (!(name in value)) throw new ProviderError(`Structured output ${path}.${name}: missing required property`);
    for (const [name,child] of Object.entries(value)) {
      if (schema.properties?.[name]) assertJsonShape(child,schema.properties[name],`${path}.${name}`);
      else if (schema.additionalProperties===false) throw new ProviderError(`Structured output ${path}.${name}: unexpected property`);
    }
  }
  if (actual==='array') {
    if (schema.minItems!==undefined && value.length<schema.minItems) throw new ProviderError(`Structured output ${path}: too few items`);
    if (schema.maxItems!==undefined && value.length>schema.maxItems) throw new ProviderError(`Structured output ${path}: too many items`);
    value.forEach((item,i)=>assertJsonShape(item,schema.items,`${path}[${i}]`));
  }
  return value;
}

export async function generateStructured({system,user,schema,name='research_slide_plan'},options={}) {
  const config=providerConfig(options.config), fetchImpl=options.fetchImpl||globalThis.fetch, env=options.env||process.env;
  const format={type:'json_schema',name,strict:true,schema};
  const messages=[{role:'system',content:system},{role:'user',content:user}];
  const body=config.mode==='responses'
    ? {model:config.textModel,input:messages,text:{format},store:false}
    : {model:config.textModel,messages,response_format:{type:'json_schema',json_schema:{name,strict:true,schema}}};
  const endpoint=config.mode==='responses'?'responses':'chat/completions';
  const data=await request(endpoint,body,{config,fetchImpl,env});
  if (data.status && data.status!=='completed') throw new ProviderError(`Text generation was not completed: ${data.status}`);
  const content=config.mode==='responses'
    ? (data.output||[]).flatMap(item=>item.content||[])
    : [data.choices?.[0]?.message||{}];
  if (content.some(item=>item.type==='refusal'||item.refusal)) throw new ProviderError('Text model refused the requested structured output.');
  const text=config.mode==='responses'
    ? (data.output_text||(content.filter(item=>item.type==='output_text').map(item=>item.text).join('')))
    : data.choices?.[0]?.message?.content;
  if (typeof text!=='string'||!text.trim()) throw new ProviderError('Text API returned no structured text.');
  let value;
  try { value=JSON.parse(text); } catch { throw new ProviderError('Text API returned invalid JSON.'); }
  return assertJsonShape(value,schema);
}

export async function generateScientificImage(prompt,options={}) {
  const config=providerConfig(options.config),fetchImpl=options.fetchImpl||globalThis.fetch,env=options.env||process.env;
  const data=await request('images/generations',{
    model:config.imageModel,prompt,n:1,size:config.imageSize,quality:config.imageQuality,
    background:config.imageBackground,output_format:'png',
  },{config,fetchImpl,env});
  const encoded=data.data?.[0]?.b64_json;
  if (typeof encoded!=='string'||!encoded) throw new ProviderError('Image API did not return b64_json; no image was saved.');
  const bytes=Buffer.from(encoded,'base64');
  const signature=Buffer.from([137,80,78,71,13,10,26,10]);
  if (bytes.length<8||!bytes.subarray(0,8).equals(signature)) throw new ProviderError('Image API result is not a PNG.');
  return {bytes,usage:data.usage||null,model:config.imageModel};
}
