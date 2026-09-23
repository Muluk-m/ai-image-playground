# 反推语料：商品图提示词的公开写法

调研自各家公开的提示词指南与开源提示词集（来源见末尾）。这里只收**结构与词表**，
不收具体成品提示词——照抄别人的成品会把别人的商品也抄进来。

## 一、公认的分段结构

几家指南给出的结构高度一致，差别只在叫法：

| 段 | 写什么 | 常见叫法 |
| --- | --- | --- |
| 主体 | 品类、材质、颜色、包装、标签文字、尺寸线索、不可变的特征 | Subject / Product accuracy |
| 构图 | 景别、视角、朝向、占比、留白 | Composition / Framing |
| 环境 | 影棚还是实景、什么房间、什么台面、什么道具 | Environment / Background |
| 光线 | 主光方向与硬软、补光、轮廓光、阴影、色温 | Lighting |
| 细节 | 材质质感、反射、投影、比例参照 | Details / Detail cues |
| 用途 | 商品页、广告、社媒、平台主图 | Intended use |
| 禁止 | 不许出现的东西 | Restrictions / Negative |

一份被反复引用的电商模板（[cliprise/awesome-ai-product-photography-prompts]）：

```
Create a [比例] product photo for [商品].
Product accuracy: [形状、颜色、包装、标签、材质]
Composition: [正面 / 三分之四 / 微距 / 平铺 / 主图 / 生活方式]
Environment: [影棚 / 居家 / 厨房 / 卫浴 / 桌面 / 户外]
Lighting: [柔和日光 / 影棚光 / 轮廓光 / 高调 / 暗调奢华]
Details: [质感、反射、投影、比例、表面]
Restrictions: [不要编造文字、不要扭曲标签、不要多余商品]
```

**顺序有讲究**：先写主体（模型先解析名词），再写风格。
OpenAI 的图像提示词指南把这条写成「lead with the subject」：
`matte black ceramic coffee mug` 比 `a beautiful image of a coffee mug` 好。

## 二、光线词表

「光线是提示词里最被低估的一段」——默认光又平又假，加一两个具体的光线词，成片质量的变化最大。

- 方向：`left key light` 左主光 / `45° side-top` 45° 侧顶 / `backlit` 逆光 / `top-down` 顶光 / `window light` 窗光
- 硬软：`hard light with crisp shadows` 硬光硬影 / `soft diffuse` 柔和漫射 / `large softbox overhead` 顶部大柔光箱
- 经典布光：三点布光（主光 + 弱补光 + 轮廓光）、伦勃朗光（45° 主光在暗侧颧骨下压出三角）、蝴蝶光（正顶）、分割光（侧对侧）
- 商业调性：`high-key white studio` 高调白影棚（平台主图）/ `low-key cinematic` 暗调电影感（奢侈品）/ `golden hour` 黄昏光
- 阴影与反射：`soft contact shadow under the product` 贴地柔影 / `controlled reflections` 受控反射 / `subtle rim light separating from background` 轮廓光分离背景

## 三、机位与镜头词表

- 景别：`close-up` / `medium` / `wide shot` / `macro`
- 视角：`eye-level` 平视 / `low-angle` 仰拍 / `top-down (flat lay)` 俯拍平铺 / `three-quarter view` 三分之四
- 镜头：`50mm` 接近人眼观感 / `85mm` 轻压缩、适合静物 / `90mm macro` 微距细节 / `35mm` 带环境
- 景深：`shallow depth of field` 浅景深隔离主体 / `focus stacked, edge-to-edge sharpness` 全清晰
- 一个词就能改掉整张构图：把 `close-up` 换成 `flat lay`，画面会完全不同。

## 四、材质与质感

写材质要写「它对光怎么反应」，不要只写名字：

- 哑光陶瓷：`matte ceramic, diffuse highlights, no specular hotspot`
- 玻璃 / 树脂：`translucent, light transmits through the wall, visible thickness at the rim, caustics on the surface below`
- 金属：`brushed / polished metal, specular streak highlights, mirrors the environment`
- 织物：`fabric weave visible at close range, soft falloff`
- 微水泥 / 石材：`matte microcement with fine grain, visible slab seams`

## 五、约束与禁止项的写法

改图类指令的公认写法：**把「要改的」和「要保的」分开写**。
OpenAI 的图像提示词文档原话是 separate changes from constraints：说清 change only X，
再逐条列出必须保持不变的身份、几何、版式、光线与标签。

常用禁止项：

- `no extra products` 不要多出一件商品
- `no fake text, no invented label copy` 不要编造文字与标签内容
- `no warped reflections` 不要扭曲的反射
- `no watermark, no logo overlay` 不要水印与叠标
- `do not alter the product's shape, color, material, or label` 不改商品本体

**编造文字是电商图最高频的事故**：中文尤其容易糊、错、写出商品没有的承诺。
默认写进禁止项，用户明确要文字时再放开，并提醒人工核对。

## 六、把语料落进模板正文时

- 词表是用来**写第 4 节工作流程**的，不是整段抄进模板。一张图只需要三五个具体光线 / 机位词。
- 模板的第 3 节是素材位：主体那一段永远写成「用户提供的素材」，不写具体商品。
- 英文词表只是词源；写给中文用户看的模板正文用中文写，需要时在括号里留英文词。

## 来源

- [OpenAI 图像提示词指南](https://developers.openai.com/api/docs/guides/image-prompting)：先写主体、改图要分开写「改什么」与「保什么」。
- [OpenAI Cookbook: 图像生成模型提示词指南](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide)：景别 / 视角 / 光线与情绪的分项写法，镜头与胶片质感的示例。
- [cliprise/awesome-ai-product-photography-prompts](https://github.com/cliprise/awesome-ai-product-photography-prompts)：电商商品图的分段模板。
- [cliprise/awesome-seedream-5-prompts](https://github.com/cliprise/awesome-seedream-5-prompts)：主体 / 构图 / 环境 / 光线 / 细节 / 用途 / 限制 七段结构。
- [ZeroLu/awesome-nanobanana-pro](https://github.com/ZeroLu/awesome-nanobanana-pro)：三点布光与轮廓光的提示词写法。
- [EvoLinkAI/awesome-gpt-image-2-API-and-Prompts](https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts)：电商场景下的光线与背景词。
