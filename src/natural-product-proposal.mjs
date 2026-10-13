/** High-level natural-product research questions; not laboratory operating instructions. */
const short=(value,fallback)=>typeof value==='string'&&value.trim()&&[...value.trim()].length<=16?value.trim():fallback;
const card=(heading,caption,steps)=>({heading,caption,steps,
  visualDescription:`拟议科研问题：${steps.join(' → ')}。不包含实验结果、操作条件或具体化合物结构。`});

export function naturalProductProposal(project) {
  const brief=project.brief&&typeof project.brief==='object'&&!Array.isArray(project.brief)?project.brief:{};
  const plant=short(brief.plantSource,'植物来源材料');
  const extract=short(brief.extractName,'粗提物');
  const candidate=short(brief.candidateName,'候选天然产物');
  const topic=project.topic.trim();
  const supplied=typeof brief.researchQuestion==='string'&&brief.researchQuestion.trim()
    && [...brief.researchQuestion.trim()].length<=100?brief.researchQuestion.trim():'';
  const mainQuestion=supplied||([...topic].length<=52
    ? `围绕“${topic}”，哪些成分与效应相关，效应、安全性及作用解释是否一致？`
    : '植物来源材料的哪些成分具有候选价值，如何区分效应、安全性与不同作用解释？');
  return {
    mainQuestion,
    questionCards:[
      card('植物与候选成分',`${plant}、${extract}与${candidate}的身份分别确认`,
        ['保留植物来源身份','对应粗提物成分资料','识别候选成分线索']),
      card('效应与安全性','效应信号与宿主安全性并行解释',
        ['明确候选效应问题','区分宿主损伤信号','评价选择性与证据边界']),
      card('成分与作用解释','成分关联、直接作用与宿主反应分别检验',
        ['对应成分与效应线索','比较不同作用解释','界定候选开发价值']),
    ],
    researchTitles:['研究内容一｜粗提物的候选价值','研究内容二｜成分关联与候选优先级','研究内容三｜作用解释与转化边界'],
    researchCards:[
      card('粗提物候选价值',`检验${extract}的效应信号及其一致性`,
        ['对应粗提物与效应证据','识别支持与不支持结果','形成候选价值判断']),
      card('效应与毒性边界','区分候选效应与非特异宿主损伤',
        ['并列效应与宿主状态','区分特异信号与损伤','评价选择性与适用范围']),
      card('成分与效应关联',`将成分资料与效应线索对应，关注${candidate}`,
        ['确认成分身份与来源','对应成分特征与效应','区分相关与因果解释']),
      card('候选优先级','根据成分明确性、效应及安全性资料综合判断',
        ['核对候选身份可信度','并列效应与安全性支持','形成优先级与保留理由']),
      card('作用路径假设','比较直接作用与宿主反应的不同解释',
        ['提出直接作用解释','提出宿主反应解释','识别关键分歧与缺口']),
      card('转化证据边界','核对效应、成分与机制资料能支持哪些结论',
        ['核对不同证据一致性','识别选择性与稳定性疑问','界定后续开发价值']),
    ],
    planTitle:'后续计划｜候选价值到作用解释',
    planCards:[
      card('目标与比较','明确粗提物问题与效应—安全性比较',
        ['明确研究对象','确定核心比较','形成解释规则']),
      card('成分与候选','整理成分身份并形成附理由的候选优先级',
        ['核对植物与成分资料','对应成分与效应线索','形成候选清单']),
      card('机制与分歧','比较不同机制假设能够解释的现象',
        ['列出作用解释','识别关键分歧','整理支持与反驳证据']),
      card('复核与转化','复核证据一致性并明确后续研究依据',
        ['复核关键证据','界定可支持结论','形成后续研究依据']),
    ],
  };
}
