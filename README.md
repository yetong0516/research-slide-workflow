# Research Slide Workflow

**当前为私有维护的科研工具；本次对外只展示设计思路和成品效果。核心实现暂不公开，科研用途限定共享须由作者另行决定并明确授权。** 许可范围见 [LICENSE](LICENSE) 和[展示与共享范围](docs/distribution-policy.md)。以下操作说明仅供作者和明确授权的内部人员使用。

**给出研究题目，生成以科研图为主、文字可编辑的研究背景、研究内容、后续计划与参考文献 PPT。**

面向生物医学科研汇报。把「找文献 → 核对主张和图数据 → 按项目设计科研图 → 制作可编辑 PPT → 渲染复查」整理为可重复运行的命令行流程。现在提供两套模板：`proposal` 开题框架为七页，背景 → 科学问题 → 研究内容三页 → 研究计划 → 参考文献；`compact` 保留原来的五页精简汇报。明确提供且核查过的前期图数据可另加前期基础页。

题目足以生成**拟议研究设计草稿**；实际队列、已完成实验、发表成果和真实结果需要额外项目说明。背景结论只有在记录具体原文核查后才进入正式版。工具不会把生成图冒充论文图，也不会把检索到的 DOI 当作结论核实。

## 开题框架：输入题目即可生成可编辑结构

```bash
npm ci
node cli.mjs create "植物来源天然产物的抗流感候选价值与活性成分研究"
```

这条命令使用 `proposal` 模板，不需要模型密钥。输出目录显示在运行结果中，包含 `project.json`、证据记录、可修改的内容 JSON 和 `research.pptx`。默认生成离线结构草稿：研究问题、左右研究任务和计划有原生可编辑流程图；背景事实保留“待核实”位置。天然产物课题沿「粗提物候选价值 → 成分关联 → 作用解释与转化」组织，不套用临床预测模型。临床研究、公开证据评价及其他题目使用相应框架，具体方案需提供项目条件或接入模型。

需要检索真实文献时追加 `--query "英文 PubMed 检索式"`；需要按题目具体规划，可追加 `--provider openai` 并配置自己的密钥。两者都保留独立核查环节。重复 `create` 不覆盖已有项目，后续用 `run project.json` 继续；详情见[开题模板说明](docs/proposal.md)。

默认范例为**植物来源天然产物抗流感课题**，包含真实文献数据与授权论文原图：

[内部保存的八页可编辑PPT](examples/natural-antiviral/example.pptx)

```bash
npm run demo
```

打开 `build/proposal/research-slides.pptx`。这份八页示例包含背景、科学问题、独立文献依据、三页研究内容、后续计划和参考文献。文字、重绘的数据图、区间端点、流程节点和箭头为 PowerPoint 原生对象；论文原图和设计插图是可独立替换的图片。植物 X、粗提物 X 和 NP 保留原课题标记；黄芩素/黄芩苷只作为外部已发表依据，不冒充项目结果。详见[天然产物示例说明](examples/natural-antiviral/README.md)。

每个主题使用独立原生边框，按标题、主图和正文形成清楚的层级。重复的图像身份标签、交付提示和通用页脚移入备注；文献身份、原图许可与数据解释仍保留在备注及参考文献中。研究内容和计划的标题保留“拟开展”。

原生文字、图表、备注及主题默认使用中文 **微软雅黑**、英文 **Arial**。论文原图和设计位图保持原貌。可在 `project.design.fonts` 或 `spec.theme.fonts` 设置 `{ "eastAsian": "微软雅黑", "latin": "Arial" }`。目标电脑需要安装相应字体；缺失时会被本机字体替代，应重新检查换行与字形。

![天然产物抗流感背景：真实人群数据、临床研究与前临床原图](docs/preview/natural-background.png)

![天然产物课题科学问题与设计示意](docs/preview/natural-question.png)

## 内部运行：无需密钥

需要 Node.js 20+。示例使用已附科研设计 PNG 和公开文献数据，不调用付费 API。

```bash
npm ci
npm run demo
```

打开 `build/proposal/research-slides.pptx`。标题、说明、出处和原生数据图可以编辑；插图是独立可替换的图片对象。位图内部的线条/细胞不是独立 PowerPoint 形状。原五页精简示例可用 `npm run demo:compact`，脓毒症开题示例可用 `npm run demo:sepsis`，均为明确选择的补充示例。

## 从自己的题目开始

可先提供英文 PubMed 检索式，避免中文长题目零命中：

```bash
node cli.mjs init \
  --topic "植物来源天然产物抗流感候选研究" \
  --query "influenza AND (natural products OR flavonoids)" \
  --template proposal \
  --out runs/my-study/project.json
node cli.mjs run runs/my-study/project.json
```

默认 `rules` 规划和 `native` 模式无需模型密钥：检索真实文献，保留待核实背景与待配图框，再输出清楚标注的设计草稿。原生数据图需提供经过核查的数字，设计图需生成或手动加入。它是起点，具体方法需补充项目条件。`runs/` 默认不提交 Git。

希望按题目生成更具体的方案和 7–8 张科研示意图：

```bash
export OPENAI_API_KEY="填入你自己的API密钥"
node cli.mjs run runs/my-study/project.json --provider openai --mode openai
```

有密钥时，未给英文 query 的中文题目会先生成英文检索表达式。文本和图像接口可能产生费用，模型/地址/质量可在 `project.json` 的 `provider` 中修改；模型访问取决于自己的账户。未调用模型时不会假称 AI 已生成配图。

不要将患者信息、凭据或未获授权的未公开材料填进会发给外部模型的 `brief`。需要脱敏后的项目约束时，可用 `--brief examples/brief.template.json`；附件内容被当作资料，不是可执行指令。

## 分步控制与核查

```bash
node cli.mjs research runs/my-study/project.json
node cli.mjs plan runs/my-study/project.json --provider openai
# 核对 evidence.planned.json 的候选原句，添加具体的 claim review 与图数据来源
node cli.mjs plan runs/my-study/project.json \
  --evidence runs/my-study/output/evidence.planned.json --provider openai
node cli.mjs images runs/my-study/output/spec.json \
  --project runs/my-study/project.json --mode openai
node cli.mjs validate runs/my-study/output/spec.images.json --final
node cli.mjs build runs/my-study/output/spec.images.json --final
```

具体字段见 [文献核查](docs/evidence.md) 与 [完整工作流](docs/workflow.md)。关键 distinction：

| 内容 | 来源 | 展示要求 |
| --- | --- | --- |
| 背景事实/数字 | 已核查的真实文献 | 对应原句/图表位置、单位、比较与出处 |
| 论文原图 | 明确原始来源 | 保留坐标与图例，核对再利用许可 |
| 科研设计图 | AI 生成或原生示意 | 所属研究页标「拟开展」，备注保留图像身份，不承载实证数字 |
| 项目实际结果 | 项目提供且核实的材料 | 与已发表基础、未来计划分开 |

程序记录 `discovered → metadata verified → excerpt matched → reviewed claim` 的不同状态。原句命中不能证明翻译、外推或终点解释正确。人工核查完成后，在来源 `claims[]` 内记录已核查版本的 `text`、`status: "checked"`、`reviewed: true`、`reviewer`、`reviewNote` 与 `locator`。展示 caption 必须对应该核查版本。`--final` 检查核查记录完整性，不能替代科学判断。

未核查背景会有可见草稿提示。已核查主张还需要自己的原图或真实图数据；占位框不会被程序假装成文献配图。不要凭摘要还原论文没有给出的原始点、ROC 或生存曲线。

## 文件与可重复运行

每个项目输出独立文件：`evidence.json`、`evidence.planned.json`、`spec.json`、`spec.images.json`、`assets/`、`image-manifest.json` 和 PPT。`run` 默认续用已存的证据和排版，不覆盖人工核查及手改；需要重新规划请显式使用 `plan`。修改内容 JSON 后可以只重新 `build`；图片失败时已有图保留在进度文件，可用进度 spec 继续 `images`，避免重复生成。

- `src/evidence.mjs`：PubMed 检索与 Crossref / PubMed / Europe PMC 身份核对。
- `src/providers.mjs`：公共 HTTP 文本结构化输出和图像生成接口，可注入 mock。
- `src/workflow.mjs`：题目、约束、证据状态、科研图与 PPT 的编排。
- `src/schema.mjs`、`src/render.mjs`：数据契约与原生 PowerPoint 排版。
- `examples/demo/`：可离线运行的五页示例及图示出处说明。
- `prompts/`：科研设计图提示词骨架。
- `scripts/`：保存文件结构检查与可选渲染。

模型配置通过 `--config provider.json` 传给 `init`，例如：

```json
{
  "mode": "responses",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "textModel": "gpt-4.1-mini",
  "imageModel": "gpt-image-1",
  "imageSize": "1536x1024",
  "imageQuality": "medium"
}
```

也可用 `mode: "chat-completions"` 连接支持对应格式的兼容文本端点；图片端点仍需支持 GPT Image 的参数及 PNG base64 返回，并非任意服务商都兼容。请只把密钥发送到自己信任的 `baseUrl`。

接口实现依据 [OpenAI 结构化输出文档](https://developers.openai.com/api/docs/guides/structured-outputs) 和 [图像生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate)。文献服务说明见 [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/)、[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) 与 [Europe PMC REST 服务](https://europepmc.org/RestfulWebService)。排版使用公开的 [PptxGenJS](https://github.com/gitbrent/PptxGenJS)，不依赖桌面应用私有运行时。

## 验证与预览

```bash
npm test
npm run demo
python3 scripts/inspect-pptx.py build/proposal/research-slides.pptx --expected-slides 8
# 可选：先安装 LibreOffice 与 Poppler
python3 scripts/render.py build/proposal/research-slides.pptx --out build/preview
```

逐页查看 PNG，检查中文字形、换行、图例、箭头、配图和文字是否匹配。字体在不同电脑可能替换，可分别在 `theme.fonts.eastAsian` 和 `theme.fonts.latin` 选择本机中文、英文字体。

第一版的付费文本/图像接口通过 mock 测试；离线 PPT 构建、结构检查与公开文献 API 已实际运行。生成新研究的完整付费 API 路径仍需读者用自己的账户验证，不能把 mock 通过说成真实模型请求成功。当前检索入口以 PubMed 生物医学文献为主；其他学科可增加检索适配器。

## 维护与许可

内部维护可补充文献检索、版式、原生可编辑图型和经过核查的示例。修改后运行测试与示例；新增证据必须给原始出处及适用范围。

v0.4.1 起当前分发不再默认授予作者自有材料的复用许可。未经另行明确书面授权，不提供将新版本实现商业包装、收费服务、转售或重新发布的许可。后续科研用途共享范围由作者另行决定。已合法获得的旧 MIT 副本权利保留；第三方依赖、文献、图片和数据仍遵守各自原有权利及引用要求。仓库不包含实际患者资料、原始课题汇报或未公开结果。

English: An evidence-aware CLI for editable scientific slides. It separates bibliographic verification, claim review, real chart data, and proposed design imagery. Run `npm run demo` without an API key; optional OpenAI planning and illustration are configurable. Title-only inputs create proposed designs, not performed-study results.
