# 电商视觉相邻设计工具证据

核查日：2026-10-15（Asia/Taipei）。均为官方文档/产品页面；未登录实测、未付费生成。功能质量与效果不排名。Adobe 按产品组比较，不能理解为一个订阅或一个入口拥有全部能力。Canva 国际版不能外推为可画中国版；Figma Buzz 文档仍标 beta。

## 可借鉴的操作与边界

| 产品 | 本轮明确能力 | 有价值的操作细节 | 不能外推的边界 | 来源 |
|---|---|---|---|---|
| Lovart | 抠透明底、超分、消除、扩图 | 选图即有具名操作，扩图可指定边界与比例 | 抠复杂毛发需修边；不是全品类无损 | D01 |
| Lovart | 点选对象修改、拆图层、改字 | 标记进入对话引用；拆分后可改文字字体/尺寸并重排 | 点选每次最多10标记；拆层对清晰主体更适用；Edit Text仍是生成动作 | D02 |
| Lovart | 按对象类型导出 | 位图PNG/JPEG，多对象PSD，矢量对象SVG；幻灯片另有PPTX | 不能说任意生成图都天然是完整可编辑PSD | D03 |
| Lovart | 资产与Brand Kit、技能、Mockup | Brand Kit存颜色、字体、Logo等上下文；Mockup先放置再栅格化 | Brand Kit是生成参考，不等于像素/版式硬锁；SVG需外部编辑器修改路径 | D04/D05/D06 |
| Canva | 基础修图、生成背景、局部编辑、超分、扩图 | 图像工具可接回设计文档 | AI能力受套餐与额度控制 | D07 |
| Canva | Grab Text、Magic Layers | 位图文字可转文字框；图层可移动替换 | Grab Text文档仅支持拉丁字母，不在中国提供；Magic Layers单页PNG/JPG、最长边≤5000px，摄影图分离效果不确定 | D08/D09 |
| Canva | 表格批量套版 | 列关联文字/图片框，行对应设计；多页需逐页连接，桌面合格套餐可用 | 150字段；Canva Sheets路径300行；云图库图片URL不当图片，需嵌入单元格 | D10 |
| Canva | 品牌模板与翻译 | 模板约束与翻译设计是现成产品类别 | 不把翻译能力当商品术语正确或所有文字自动不溢出 | D11/D12 |
| Adobe Express | 可控模板、审批 | 可锁元素、限字体颜色与素材来源、配置审核 | Teams/Enterprise能力；不要合并成普通个人套餐默认有 | D13 |
| Adobe Express | 表格套版、透明下载、精确尺寸 | CSV映射文字和素材生成页面，PNG透明需No fill | 批量最多249变体；单页裁剪不支持多页批量 | D14/D15/D16 |
| Photoshop | 选区参考替换/放置 | 区分参考对象/整图与替换/放入两个维度 | Firefly路径与Partner模型路径不同，参考张数依模型；不意味着实物保真保证 | D17 |
| Figma Buzz | 结构化批量、模板字段 | CSV/XLSX文本和图片映射；可用公共图片URL，每对象一个数据字段 | beta；锁定对象需去掉编辑限制才能映射，批量本地化可来自准备好的表格并非自动翻译证明 | D18 |
| Recraft | 栅格/矢量、超分、去背、Mockup | 真实SVG与商品印花展示覆盖POD设计工作 | 矢量输出不等于把商品摄影图拆成设计源稿 | D19/D20 |
| Recraft | 样式复用、成组视觉、印刷导出 | 保存样式，组图按同一风格；TIFF CMYK与最高300DPI | 组图资料针对插画/图标，不等于电商主图详情分工；印刷无需作为在线电商首期基线 | D21/D22/D23 |

## 对Muvloom的启示（分析，不是厂商事实）

1. 要区分四种批量：文件处理、同操作多图、同模板多商品、字段驱动精确排版。不能以一个批量按钮代表全覆盖。
2. 要区分三种模板：提示词/参考效果、可编辑版式、字段与品牌约束的生产模板。我们补齐时应明确需要哪一种。
3. 位图生成、位图改字、OCR提字、原生文字层、完整拆层是五种不同能力；便宜而精确地修改价格是独立验收项。
4. 基础能力补齐可采用原生确定性处理、专用API、Agent技能组合，不要求全部自研模型。
5. 中文商品文字不能照搬Canva Grab Text宣传；必须把语言与斜面包装文字作为验收样本。
6. 先完成带独立文字/Logo的简单商品卡，再决定是否需要任意位图自动拆层，能控制早期范围。

## 官方来源索引

| ID | 来源 | 本次用途 |
|---|---|---|
| D01 | [Lovart Basic AI Editing](https://www.lovart.ai/docs/edit-your-design/basic-ai-editing) | 透明去背/超分/消除/扩图 |
| D02 | [Lovart Advanced AI Editing](https://www.lovart.ai/docs/edit-your-design/advanced-ai-editing) | 标记/拆层/改字与限制 |
| D03 | [Lovart Export Formats](https://www.lovart.ai/docs/export-formats) | 依对象类型导出 |
| D04 | [Lovart Adding References](https://www.lovart.ai/docs/how-to-prompt/adding-references) | 资产与品牌参考 |
| D05 | [Lovart Agent Skills](https://www.lovart.ai/docs/how-to-prompt/agent-skills) | 任务入口 |
| D06 | [Lovart AI Transformation](https://www.lovart.ai/docs/edit-your-design/ai-transformation) | Mockup/矢量限制 |
| D07 | [Canva Photo Editor](https://www.canva.com/help/image-editor/) | 修图能力分类 |
| D08 | [Canva Grab Text](https://www.canva.com/help/using-grab-text/) | 拉丁文字/区域与文档限制 |
| D09 | [Canva Magic Layers](https://www.canva.com/help/editable-magic-layers/) | 拆层输入与质量边界 |
| D10 | [Canva Bulk Create](https://www.canva.com/help/bulk-create/) | 数据字段与批量限制 |
| D11 | [Canva Brand Templates](https://www.canva.com/business/features/team-templates/) | 品牌受控模板 |
| D12 | [Canva Translate](https://www.canva.com/translate/) | 设计翻译 |
| D13 | [Adobe Express Template Controls](https://helpx.adobe.com/express/web/brands-libraries-projects/create-manage-brands/template-control.html) | 锁定/来源/审批/套餐 |
| D14 | [Adobe Express Bulk Create](https://helpx.adobe.com/express/web/bulk-create-and-automate/bulk-create.html) | 249变体/CSV |
| D15 | [Adobe Express Transparent Background](https://helpx.adobe.com/in/express/create-and-edit-images/edit-images/remove-background.html) | 透明PNG下载条件 |
| D16 | [Adobe Express Crop Pages](https://helpx.adobe.com/sg/express/web/arrange-layers-and-pages/crop-pages.html) | 精确裁剪/批量边界 |
| D17 | [Photoshop Reference Image](https://helpx.adobe.com/nz/photoshop/desktop/create-open-import-images/create-images/use-reference-images-for-consistent-results.html) | Object/Whole image与Swap/Place |
| D18 | [Figma Buzz Bulk Create](https://help.figma.com/hc/en-us/articles/31271824185623-Bulk-create-assets-in-Figma-Buzz) | 结构化字段/图片/锁定限制 |
| D19 | [Recraft Studio](https://www.recraft.ai/studio) | 生成/矢量/超分/去背 |
| D20 | [Recraft Mockup](https://www.recraft.ai/mockup-generator) | POD与商品样机 |
| D21 | [Recraft Image Sets](https://www.recraft.ai/blog/how-to-create-image-sets) | 同风格组图；文章2024-11-26，不当作电商套图 |
| D22 | [Recraft DPI/CMYK](https://www.recraft.ai/features/dpi) | TIFF印刷交付 |
| D23 | [Recraft POD](https://www.recraft.ai/professional/print-on-demand-entrepreneurs) | 样式复用与格式 |
