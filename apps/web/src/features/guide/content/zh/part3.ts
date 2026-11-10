import { SUPPORT_CONTACT, SUPPORT_MAILTO } from '@image-playground/shared/support-contact'
import { faq, type GuidePage, list, note, p, prompt, steps, table, tip, warn } from '../../model'
import { demo, still } from '../media'

const updated = '2026-11-10'

export const canvasBasics: GuidePage = {
  id: 'basics',
  title: '画布基本操作',
  summary: '新建画布、移动缩放、标注，以及把一张图放进项目。',
  meta: {
    title: '画布基本操作 - 幕芽 Muvloom 使用指南',
    description: '幕芽画布的项目、快捷键、标注和导出。局部改图见智能改图页。',
  },
  updated,
  intro: [
    p(
      '画布是一块可以平移和缩放的项目。新结果放在原图旁边，方便对比。图片生成的作品卡片不会自动出现在画布上，要用 [[放入画布]]，或从 [[画布创作]] 直接开一张。',
    ),
  ],
  sections: [
    {
      id: 'canvas-projects',
      title: '新建与打开',
      blocks: [
        list(
          '[[选择创作方式]] 选 [[画布创作]]，写需求，点 [[开始创作]]。地址会变成 `/p/…`。',
          '侧栏「画布」一栏的 [[+]] 新建空白项目。',
          '作品卡片上的 [[放入画布]] 把已有的图带进项目。',
        ),
        p(
          '项目自动保存。换浏览器登录同一账号可以再打开。侧栏列出最近的项目名，名字来自第一句提示词。',
        ),
        still('zh', 'canvas', '画布：对话、工具栏和图片'),
      ],
    },
    {
      id: 'canvas-basics',
      title: '界面与快捷键',
      blocks: [
        steps(
          '左侧是对话，可以 `@` 引用画布上的图。',
          '工具栏：选择、抓手、画笔、橡皮、箭头、文字。',
          '选中一张图后出现操作条：智能改图、擦除、抠图、整图编辑、裁剪、扩图。',
          '滚轮缩放，按住空格拖动平移。',
        ),
        table(
          ['操作', '快捷键'],
          ['选择 / 抓手', '{{V}} / {{H}}'],
          ['画笔 / 箭头 / 文字', '{{D}} / {{A}} / {{T}}'],
          ['撤销 / 重做', '{{⌘}}{{Z}} / {{⌘}}{{⇧}}{{Z}}'],
          ['临时平移', '按住 {{Space}} 拖动'],
          ['缩放', '{{⌘}} + 滚轮'],
        ),
        note('Windows 用 {{Ctrl}} 代替 {{⌘}}。'),
      ],
    },
    {
      id: 'canvas-annotate',
      title: '标注',
      blocks: [
        p(
          '画笔、箭头和文字是画在图上的标记，发给智能体时会一起带上。按 {{D}} 圈出位置，按 {{T}} 写「换成金色瓶盖」，再在对话里说要改什么。这和 [[智能改图]] 的遮罩不是同一步：标注是说明，遮罩是限定像素区域。',
        ),
        warn(
          '工具栏橡皮会删掉碰到的整个元素，包括图片。误删用 {{⌘}}{{Z}}。要去掉画面里的物体，用操作条的 [[擦除]]，不要用这块橡皮。',
        ),
      ],
    },
    {
      id: 'canvas-export',
      title: '多选和导出',
      blocks: [
        list(
          '按住 {{Shift}} 点选多张，或框选。底部出现批量栏。',
          '[[批量生成]] 对每张图用同一句描述再出一版。',
          '[[导出]] 一张直接下载，多张打成 ZIP。',
        ),
      ],
    },
  ],
  related: ['canvas/inpaint', 'create/video', 'assets/library'],
}

export const canvasInpaint: GuidePage = {
  id: 'inpaint',
  title: '智能改图与圈选',
  summary: '在画布上框住要改的区域，只改那一块，其余保持原图。',
  meta: {
    title: '智能改图与圈选 - 幕芽 Muvloom 使用指南',
    description: '幕芽画布智能改图：框选、画笔、发送给智能体，以及按钮不可用时的原因。',
  },
  updated,
  intro: [
    p(
      '智能改图用遮罩告诉模型「只动这里」。没有遮罩的整图修改是 [[整图编辑]]，不要拿它代替圈选。需要支持遮罩的模型，GPT Image 系列可以。按钮灰掉时，悬停看原因，不要改走另一条功能冒充。',
    ),
    note(
      '2026-11-10 测试环境的节点画布上，已上传的陶瓷杯可以选中。点 [[编辑图片]]，编辑方式选 [[局部重绘]]，用 [[框选]] 框住杯身，修改要求是「把杯身釉色换成雾面墨绿，杯把保持原样」，再点 [[生成新候选]]。杯身变成墨绿，杯把仍是原来的浅色。队列请求 id 是 `e5a96636-d49e-4d1c-8e3f-e2152bb466d2`。出片后画布短暂显示「图片上传中 0/1」，上传随后完成，指示消失。',
    ),
  ],
  sections: [
    {
      id: 'inpaint-steps',
      title: '框选并发送',
      blocks: [
        demo(
          '09-inpaint',
          '框选杯身后，杯身变成雾面墨绿，杯把仍是原来的浅色',
          '2026-11-10 测试环境：局部重绘已完成',
        ),
        steps(
          '先有一张画布上的图。可以从 [[画布创作]] 生成，例如「一只陶瓷咖啡杯放在木桌上，侧面能看到杯把」。',
          '点选这张图。节点画布的操作条上点 [[编辑图片]]，编辑方式选 [[局部重绘]]。图片操作条上的同一步叫 [[智能改图]]。',
          '工具选 [[框选]]。在要改的位置拖一个矩形，例如杯身。[[画笔]] 用来补不规则边缘。',
          '在修改要求里写改什么。',
          '点 [[生成新候选]]。新图出现在画布上，框外的部分应保持原样。',
        ),
        prompt('改色示例', '把杯身釉色换成雾面墨绿，杯把保持原样'),
        still('zh', 'canvas-inpaint', '局部重绘的框选和修改要求'),
      ],
    },
    {
      id: 'inpaint-disabled',
      title: '按钮不可用',
      blocks: [
        table(
          ['原因', '怎么处理'],
          ['当前模型不支持遮罩', '换成 GPT Image 系列，不要改用 [[整图编辑]] 假装局部'],
          ['图片太小', '局部重绘大约要 80 万像素以上'],
          ['长宽比超过 3:1', '先裁成没那么极端的比例'],
          ['图已经不在画布上', '重新放入'],
          ['还没画区域', '发送按钮保持禁用，先框一块'],
        ),
        p('视频节点没有局部重绘。GIF 和 SVG 也不能拿来圈选。'),
      ],
    },
    {
      id: 'inpaint-other',
      title: '旁边的几个工具',
      blocks: [
        table(
          ['工具', '作用'],
          ['[[整图编辑]]', '一句话改整张，不限定区域'],
          ['[[擦除]]', '涂掉物体，用周围补上'],
          ['[[抠图]]', '去背景，得到透明 PNG'],
          ['[[裁剪]] / [[扩图]]', '切掉或向外加画面'],
          ['[[调整尺寸]]', '改像素尺寸'],
        ),
        note(
          '这些都在选中图片后的操作条上。工具箱里的裁剪是另一套，在浏览器本地处理，不进画布，也不扣积分。',
        ),
      ],
    },
  ],
  related: ['canvas/basics', 'create/gpt-image-26', 'tools/toolbox'],
}

export const remix: GuidePage = {
  id: 'remix',
  title: '做同款',
  summary: '从探索里的案例把提示词、模型和设置带回创作页。',
  meta: {
    title: '做同款 - 幕芽 Muvloom 使用指南',
    description: '幕芽探索页做同款：卡片、替换当前输入、改主体后再生成。',
  },
  updated,
  intro: [
    p(
      '[[探索]] 的地址是 `/explore`。每张案例卡片悬停后出现 [[做同款]]。点下去回到创作页，提示词、推荐模型和要求过的生成设置被填进输入框。案例自带参考图时，按钮写成 [[用原图做同款]]。',
    ),
    demo(
      '10-explore-remix',
      '从探索案例做同款，提示词和模型填回创作页',
      '做同款：案例提示词回到输入框',
    ),
  ],
  sections: [
    {
      id: 'remix-card',
      title: '从卡片开始',
      blocks: [
        steps(
          '打开 [[探索]]。可以用分类缩小范围，例如 [[产品与电商]]。',
          '悬停一张卡片。[[做同款]] 在卡片下沿，旁边是复制提示词和收藏。',
          '若输入框里已经有字，会问 [[替换当前输入？]]。点 [[替换并应用]] 才会覆盖。',
          '回到 `/image` 后，看模型名是否换成案例推荐的，提示词是否已在框里。',
        ),
        still('zh', 'remix-card', '案例卡片上的做同款'),
        still('zh', 'remix-confirm', '替换当前输入的确认'),
      ],
    },
    {
      id: 'remix-detail',
      title: '详情里还能做什么',
      blocks: [
        p(
          '点开卡片（不是做同款）进入详情：完整提示词、复制、上一个下一个。高亮的词是可以换成你自己的主体。[[用作参考图]] 把案例图加进输入框，和做同款不是同一步。',
        ),
        list(
          '做同款会换模型和设置。只想借一句提示词时，用复制，不要点做同款。',
          '参考图下载失败时，不会替换你当前的输入。',
          '案例推荐的模型如果你账号里没有，会提示找不到配置，输入不会被盖掉。',
        ),
      ],
    },
    {
      id: 'remix-apply',
      title: '改完再生成',
      blocks: [
        p(
          '填入之后先改主体词，再点 [[生成]]。案例里的品牌名、地名不要原样拿去商用。探索库如果是空的，页面写「没有符合条件的灵感」，这时没有卡片可点，不要改用别的环境的图充数。',
        ),
        still('zh', 'remix-applied', '做同款之后的创作页'),
      ],
    },
    {
      id: 'remix-compare',
      title: '和参考图的差别',
      blocks: [
        p(
          '做同款带的是案例的提示词和参数。你自己的商品图要走 [参考图](/guide/create/composer/#reference-images)，用 `@` 点名。两件事可以先后做：先做同款拿到句子，再换上你的图，并改掉句子里的主体。',
        ),
      ],
    },
  ],
  related: ['create/composer', 'start/first-image', 'assets/library'],
}

export const library: GuidePage = {
  id: 'library',
  title: '资产',
  summary: '素材、提示词和模板存在资产里，和「我的作品」不是同一个列表。',
  meta: {
    title: '资产 - 幕芽 Muvloom 使用指南',
    description: '幕芽资产库：素材、提示词、模板，以及怎么放回创作。',
  },
  updated,
  intro: [
    p(
      '[[我的作品]] 是生成记录。[[资产]] 是你明确留下的东西：上传或存下来的素材、提示词、模板。换设备登录后，资产还在；只存在某一台浏览器里、没存成素材的临时图不一定在。',
    ),
  ],
  sections: [
    {
      id: 'assets-projects',
      title: '和作品、画布的分工',
      blocks: [
        table(
          ['地方', '放什么'],
          ['我的作品', '每次生成的结果，可下载、可再放入参考或画布'],
          ['画布项目', '并排编辑的那一组，侧栏按项目打开'],
          ['资产', '跨项目复用的素材、提示词、模板'],
        ),
      ],
    },
    {
      id: 'assets-materials',
      title: '素材',
      blocks: [
        steps(
          '在作品卡片上 [[存为素材]]，或在资产里上传。',
          '创作时 [[添加参考素材]] 里选 [[从资产库添加]]，不必重新从硬盘挑。',
          '单张仍要小于上传限制。存进去的图不会自动变成参考，要你再选一次。',
        ),
        still('zh', 'assets', '资产库'),
      ],
    },
    {
      id: 'assets-prompts',
      title: '提示词',
      blocks: [
        p(
          '把用顺的句子存成提示词，下次从资产插入输入框。插入的是文字，不含当时的模型和比例。模型和比例仍以你现在的生成设置为准。句子里若有 `@图1`，那是当时的引用，换一批图之后要重新从列表点选，手打的 @ 不会绑上新图。',
        ),
      ],
    },
    {
      id: 'assets-looks',
      title: '模板',
      blocks: [
        p(
          '模板把素材位和一句带槽位的提示词绑在一起。挂上模板后，参考图张数要和素材位一致，输入框不再提供逐张生成。智能体技能里的「建模板」可以把当前结果收成模板，菜单里没有这条技能就不要假设已经存好。',
        ),
        still('zh', 'assets-looks', '模板与素材位'),
        tip('模板适合反复做同一类主图。偶尔一张图，直接写提示词更快。'),
      ],
    },
  ],
  related: ['create/composer', 'create/batch', 'create/skills'],
}

export const toolbox: GuidePage = {
  id: 'toolbox',
  title: '工具箱',
  summary: '裁剪、压缩、转格式、拼图都在浏览器里完成，不上传、不扣积分。',
  meta: {
    title: '工具箱 - 幕芽 Muvloom 使用指南',
    description: '幕芽工具箱：本地裁剪、压缩、转格式、拼图和切片。',
  },
  updated,
  intro: [
    p(
      '侧栏 [[工具箱]]，地址 `/tools`。页上写着全部在浏览器本地处理，图片不会上传。因此不需要模型，也不看积分。和画布上的裁剪、抠图不是同一条：那些会调用模型。',
    ),
    demo('11-toolbox-crop', '把一张图裁成小红书 1242×1660', '工具箱裁剪：本地处理，不扣积分'),
  ],
  sections: [
    {
      id: 'tools-overview',
      title: '有哪些工具',
      blocks: [
        table(
          ['工具', '做什么'],
          ['压缩', '按质量或目标体积压小'],
          ['转格式', 'JPG、PNG、WebP、AVIF'],
          ['裁剪', '比例和电商、社媒尺寸'],
          ['旋转与镜像', '角度、水平或垂直翻转'],
          ['拼图', '宫格，可调间距和底色'],
          ['长图拼接', '竖拼或横拼'],
          ['九宫格切图', '3×3、2×2 或 1×3'],
          ['尺寸调整', '等比缩放，可顺便转格式'],
        ),
        p('可以拖入、粘贴或选文件夹。处理完的图可以下载，也可以放回创作输入框当参考。'),
        still('zh', 'toolbox', '工具箱目录'),
      ],
    },
    {
      id: 'tools-crop',
      title: '裁成小红书尺寸',
      blocks: [
        steps(
          '打开 [[裁剪]]，地址 `/tools/crop`。',
          '[[添加图片]]，选一张本地图。',
          '在 [[比例 / 尺寸]] 里点 [[小红书 1242×1660]]。旁边还有 1:1、淘宝主图 800×800、Amazon 2000×2000、抖音 1080×1920、公众号封面 900×383。',
          '卡片上的尺寸应从原图变成 1242×1660。点 [[下载]]。',
        ),
        still('zh', 'toolbox-crop', '裁剪预设里的小红书尺寸'),
        note(
          '裁切是居中取景。主体不在中间时，先在原图上留出位置，工具箱这一页不提供任意拖动到像素级的专业裁切器。',
        ),
      ],
    },
  ],
  related: ['canvas/inpaint', 'create/composer', 'assets/library'],
}

export const credits: GuidePage = {
  id: 'credits',
  title: '积分规则',
  summary: '什么时候扣、失败怎么退、2.6 的价和基础价不是同一张表。',
  meta: {
    title: '积分规则 - 幕芽 Muvloom 使用指南',
    description: '幕芽积分的扣除、退回，以及 GPT Image 2.6 的静态图、GIF 和 SVG 价。',
  },
  updated,
  intro: [
    p(
      '右上角数字是当前可用积分。生成按模型、质量、尺寸和张数扣。工具箱不扣。报价以提交前界面或 `muvloom images validate` 为准，不要把某一张基础价当成所有模型的价。',
    ),
  ],
  sections: [
    {
      id: 'credits-cost',
      title: '怎么算',
      blocks: [
        p(
          '图片模型清单里的基础价，测试环境里 Image 2.5、多数静态模型是每张 100 量级，Gemini 各档不同。这是单价。质量、分辨率和编辑会乘倍率。GPT Image 2.6 的倍率使得实际积分是下面这张表，Flare 与 Sunburst 相同。',
        ),
        table(
          ['2.6 静态图', '低', '中', '高'],
          ['1K', '190', '330', '400'],
          ['2K 与 4K', '380', '670', '810'],
        ),
        table(
          ['2.6 其他', '积分'],
          ['GIF，不超过 6 帧', '370'],
          ['GIF，7 到 9 帧', '550'],
          ['GIF，10 到 16 帧', '980'],
          ['SVG', '610'],
          ['编辑（含 1 张参考图）', '同档生成价 × 390/330，取整到 10'],
          ['每多一张参考图', '再加 60'],
        ),
        p(
          '视频按秒计价，清晰度还有倍率。Grok Imagine Video 1.5 Lite 的 1080p 是 1.6 倍，720p 不是。智能体对话本身的文字也会占积分，出图再按张另计。逐张生成是几张图几次价，不是打包价。',
        ),
        note(
          '4K 和高质量要会员。非会员选不中，命令行会得到 `PLAN_REQUIRED`。见 [会员与 4K](/guide/account/membership/)。',
        ),
      ],
    },
    {
      id: 'credits-refund',
      title: '失败与取消',
      blocks: [
        list(
          '提交失败、生成服务报错、内容未通过：按该次任务退回，不会留下半张图还扣满价。',
          '你在排队或生成中取消：退回。已经在保存结果时不能取消。',
          '命令行里 `jobs wait` 超时不是失败，任务还在跑，不要因此再提交一单。',
          '同一幂等键再提交，回到原来那张任务，不重复扣。',
        ),
        warn('连点发送会开多张任务，每张都扣。看到第一张还在生成时不要再点。'),
      ],
    },
    {
      id: 'credits-types',
      title: '余额从哪来',
      blocks: [
        p(
          '账户里可能同时有订阅余额和充值余额。可用的是两者里能花的部分，以账户概览的数字为准。新注册在开启赠送的环境里会有一笔初始积分，用完要充值或等订阅，指南不写死金额，因为运营可以改。',
        ),
        list(
          '邀请注册的奖励如果开启，会进可消费余额，和初始赠送分开记账。',
          '当日额度用尽时，命令行是 `QUOTA_EXCEEDED`，退出码 5，带重置时间。网页会提示额度，而不是无限重试。',
          '余额不足是 `INSUFFICIENT_CREDITS`，同样不要自动重试。',
        ),
        p(
          `账单和套餐入口在账户与定价页。联系 ${SUPPORT_CONTACT.email} 时带上大致时间和任务，不要发送密码或令牌。`,
        ),
      ],
    },
  ],
  related: ['account/membership', 'create/gpt-image-26', 'plugins/cli'],
}

export const membership: GuidePage = {
  id: 'membership',
  title: '会员与 4K',
  summary: '非会员最高 2K，高画质和 4K 要会员。没有会员就不要选这些档。',
  meta: {
    title: '会员与 4K - 幕芽 Muvloom 使用指南',
    description: '幕芽会员才能使用的 4K 与高画质，以及非会员会看到的限制。',
  },
  updated,
  intro: [
    p(
      '会员状态来自账户，不是前端自己猜的。非会员的最高分辨率档是 2K，[[高]] 画质不可用。会员可以选 4K，高画质也放开。查询大约缓存几分钟，刚开通后若仍看到锁定，刷新页面。',
    ),
  ],
  sections: [
    {
      id: 'who',
      title: '你会看到什么',
      blocks: [
        table(
          ['状态', '分辨率', '高画质'],
          [
            '非会员',
            '最高 2K。界面写「当前可用分辨率最高为 2K」',
            '[[高]] 不可用，旁注「高画质为会员专享」',
          ],
          ['会员', '可选 4K', '可选 [[高]]'],
        ),
        p(
          '4K 与 2K 在 GPT Image 2.6 的价目上同价，限制的是能不能选，不是选了更贵一档积分。Gemini 的 4K 是否出现在档位里，还取决于那个模型声明了 4K。模型没有 4K 档时，会员也选不到。',
        ),
      ],
    },
    {
      id: 'cli-plan',
      title: '命令行',
      blocks: [
        p(
          '`muvloom images validate --prompt "a poster" --image-size 4K` 可以只报价、不扣费。`--quality high` 同样要会员。非会员得到 `PLAN_REQUIRED`，退出码 4。改成 1K 或 2K，或把画质改成 low / medium。不要写 `3840x2160` 这种像素串，命令行只认 1K、2K、4K。',
        ),
        note('本指南的演示视频都没有使用 4K 或高画质。'),
      ],
    },
    {
      id: 'not-a-bypass',
      title: '不要绕',
      blocks: [
        list(
          '把自定义宽高写成 3840 不会变成合法的 4K 档，还可能被拒绝。',
          'GIF 只有 512 和 768，没有 4K GIF。',
          '工具箱把图放大到 2000 像素不是模型出的 4K，也不消耗会员资格。',
        ),
      ],
    },
  ],
  related: ['account/credits', 'create/settings', 'plugins/cli'],
}

export const plugins: GuidePage = {
  id: 'cli',
  title: '在 Claude Code 与 Codex 中使用',
  summary: '安装本机的 muvloom 命令，登录，再让 Claude Code 或 Codex 调用。没有 npm 包。',
  meta: {
    title: '插件集成：Claude Code 与 Codex - 幕芽 Muvloom 使用指南',
    description:
      '幕芽 CLI 0.2.4 的安装、设备码登录、生图命令、积分与退出码。正式分发是 Go 二进制 muvloom。',
  },
  updated,
  intro: [
    p(
      '插件是你电脑上的一个命令 `muvloom`，加上装进 Claude Code 或 Codex 的技能说明。仓库里没有 `@muvloom/cli`，也不能 `npx` 安装。发布版本是 0.2.4。给人看的接入页是 `/connect`，设备码批准页是 `/device`。给智能体自动执行的原文是 `/cli/setup.md` 和 `/cli/workbuddy.md`，本页与那两份对照，并以 `cli-go/` 里的命令为准。',
    ),
  ],
  sections: [
    {
      id: 'not-npm',
      title: '没有 npm 包',
      blocks: [
        list(
          '分发物是单个原生二进制：macOS arm64/x64、Linux x64/arm64、Windows x64。不需要 Node、npm 或 Python。',
          '`muvloom skill install --host` 只接受 `claude-code` 和 `codex`。写成 workbuddy 或 doubao 是 `USAGE`，退出码 2。`--scope` 只接受 `user` 和 `project`，写错是 `INVALID_REQUEST`，也是退出码 2。',
          'WorkBuddy 走 `/cli/workbuddy.md`。压缩包地址是 `/cli/muvloom-workbuddy.zip`，由网页构建脚本生成，仓库检出里默认没有这个文件。豆包要在它自己的客户端里上传技能。两边都没有 `--host`。',
          '没有 `--n` 张数参数，也没有视频子命令。一次 `images create` 出一张。多张要分多次，技能会自己拆。',
        ),
        warn(
          '不要把下面的接口路径当成 curl 教程去手写请求。那是命令行自己调用的。用户只跑 `muvloom`。',
        ),
      ],
    },
    {
      id: 'install',
      title: '安装 0.2.4',
      blocks: [
        p(
          '安装脚本钉在提交 `940f1faf1f4147d4b0add11efa5d3684aef0439c`，并校验 SHA-256。不要改去跟踪浮动的 main。装好后运行 `muvloom version`，需要 0.2.4 或更新。更低的版本就地替换，已有登录会留着。',
        ),
        prompt(
          'macOS / Linux',
          'curl -fsSL https://raw.githubusercontent.com/Muluk-m/ai-image-playground/940f1faf1f4147d4b0add11efa5d3684aef0439c/cli-go/install/install.sh | MUVLOOM_VERSION=0.2.4 sh',
        ),
        p(
          '安装目录：若已经有一份可写的 `muvloom`，就替换那一份；否则在 PATH 上且不用 sudo 就能写的 `/usr/local/bin`；再否则是 `~/.local/bin`。Windows 是已有的 `muvloom.exe` 所在目录，否则 `%LOCALAPPDATA%\\Programs\\muvloom`。可以用 `MUVLOOM_INSTALL_DIR` 指定。接入页附带的 `PATH` 导出把 `~/.local/bin` 加进当前会话；若二进制落在 `/usr/local/bin`，它本来就在 PATH 里。',
        ),
        prompt(
          'Windows PowerShell',
          '$env:MUVLOOM_VERSION = "0.2.4"; irm https://raw.githubusercontent.com/Muluk-m/ai-image-playground/940f1faf1f4147d4b0add11efa5d3684aef0439c/cli-go/install/install.ps1 | iex',
        ),
        note(
          'Windows 安装器默认会改用户 PATH。设 `MUVLOOM_NO_MODIFY_PATH=1` 则不改。ARM Windows 不在支持范围。',
        ),
      ],
    },
    {
      id: 'service',
      title: '选对服务器',
      blocks: [
        p(
          '默认 API 是 `https://api.muvloom.online`。第一次登录用 `MUVLOOM_API_URL` 选择，成功后连接会记住，以后不必再设。',
        ),
        table(
          ['你打开的网页', 'MUVLOOM_API_URL'],
          ['https://muvloom.online', 'https://api.muvloom.online'],
          ['https://image.nainma.online', 'https://api.muvloom.online'],
          ['https://image-playground.qiliangjia.one', 'https://image-api.qiliangjia.one'],
          ['https://test.muvloom.online', 'https://test-api.muvloom.online'],
        ),
        p(
          '环境变量和已经保存的连接不一致时，状态是 `service_mismatch`，错误码 `SERVICE_MISMATCH`，退出码 4。清掉变量沿用现有登录，或在你确实要换服务时运行 `muvloom auth login --switch-service`。不要为了这个再开一轮新登录。',
        ),
        list(
          '`MUVLOOM_NO_BROWSER=1` 只打印链接，不打开浏览器。SSH 和容器里用这个。',
          '`MUVLOOM_CONFIG_DIR` 指定配置目录。设了它就只用这个目录里的文件，不碰钥匙串。',
          '`MUVLOOM_CREDENTIALS_STORE=file` 把凭据放在配置目录，而不是系统钥匙串。',
        ),
      ],
    },
    {
      id: 'skill-login',
      title: '安装技能并登录',
      blocks: [
        steps(
          '`muvloom skill install --host claude-code` 装到 `~/.claude/skills/muvloom`，`--host codex` 装到 `~/.agents/skills/muvloom`。`--scope project` 只装在当前目录，默认 `user`。',
          '`muvloom skill status` 看装在哪、是不是这一版。',
          '`muvloom auth status`。状态是 ready、unauthenticated、outdated、unreachable 或 service_mismatch。不是 ready 就按状态处理，不要一律再登录。从 0.2.2 起，status 会把没改过的旧技能正文换成当前二进制里的那一份。',
          '`muvloom capabilities` 成功之后才说可以生成。用返回的 label、default_model，以及 GIF 的 `max_frames_by_size`。菜单里没有 Image 2.6，是服务端没开 `GPT_IMAGE_26_ENABLED`。',
        ),
        p(
          'Claude Code 里用 `/muvloom` 加上你的要求。Codex 用 `/` 或 `/skills` 选中 Muvloom，或 `$muvloom`。这是聊天里的叫法，终端里的命令永远是 `muvloom`。',
        ),
        p(
          '登录是设备码，有效期 20 分钟。命令行打开或打印 `/device`，你在已经登录的浏览器里点批准。`auth login --no-wait` 只打印完整链接。`--timeout` 最多 3600 秒；省略时会等到设备码过期后再多等 1 分钟，因为服务端过期后短时间内仍可能兑成令牌。超时后再跑同一条 `auth login` 会继续这一轮。用户拒绝是 `AUTH_DENIED`。只有 `AUTH_EXPIRED` 才重新开始。不要把密码、Cookie 或令牌交给智能体。',
        ),
      ],
    },
    {
      id: 'commands',
      title: '命令',
      blocks: [
        table(
          ['命令', '作用'],
          ['auth login [--no-wait] [--timeout SECONDS] [--switch-service]', '设备码登录'],
          ['auth status / auth logout', '查看连接和积分；吊销本机这条连接'],
          ['capabilities', '当前账号能用的模型、尺寸、GIF/SVG 限制和基础单价'],
          ['images validate --prompt TEXT', '校验并报价，不创建、不扣费'],
          ['images create --prompt TEXT', '生成图、GIF 或 SVG'],
          ['jobs list|get|wait|cancel', '任务。wait 超时不算失败'],
          ['artifacts get|download', '查看或保存结果'],
          ['media upload|list|get|download', '参考图'],
          ['skill install|status', '安装或查看技能'],
          ['update check / version', '检查更新；打印版本'],
        ),
        p(
          '`images create` 和 `validate` 共用 `--prompt`、`--prompt-file`、`--model`、`--aspect-ratio`、`--image-size`、`--quality`、可重复的 `--ref`、`--max-credits`、`--output-format gif|svg`、`--frames`、`--frame-duration-ms`、`--frame-size`。只有 create 还有 `--idempotency-key`（8 到 64 位，字符为字母、数字、`_` `.` `:` `-`）、`--wait`（最多 3600，0 表示提交完就返回）、`--download DIR`。',
        ),
        p(
          'GIF 或 SVG 不要带 `--ref`、`--aspect-ratio`、`--image-size`、`--quality`。帧数接口是 2 到 16，但 768 配 16 帧会被拼图上限拒绝，以 capabilities 里的 `gif.max_frames_by_size` 为准。`--image-size` 只写 `1K`、`2K`、`4K`，不要写像素串。`jobs wait` 不写 `--timeout` 时默认 300 秒。`jobs list --limit` 默认 20、最大 50；`media list` 最大 100。参考图本地只查扩展名 png、jpg、jpeg、webp，超过 50MB 由服务端回 `REQUEST_TOO_LARGE`，退出码 4。任意命令可加 `--json`。省略幂等键时，命令行会自己生成一个。`update check` 只报告有没有新版本，不会自己下载，升级仍走上面的安装脚本。',
        ),
        prompt(
          '静态图',
          'muvloom images create --prompt "a cat sticker, white background" --wait 300 --download ./out',
        ),
        prompt(
          'GIF',
          'muvloom images create --model gpt-image-2.6-flare --output-format gif --frames 8 --prompt "a cat waving, looping" --wait 300 --download ./out',
        ),
        prompt('只看 4K 报价', 'muvloom images validate --prompt "a poster" --image-size 4K'),
      ],
    },
    {
      id: 'jobs',
      title: '等待、恢复、取消',
      blocks: [
        p(
          '状态从 queued 到 running，再到 persisting，然后 succeeded，或者 failed、canceled。`jobs wait` 到时间还没结束时，结果里 `wait_timed_out` 为 true，退出码仍是 0，任务还在跑。继续对同一个 job id 等待，不要再 create。用同一个 `--idempotency-key` 重发 create 会回到原任务，不再扣点。响应丢了就 `jobs list --idempotency-key KEY`。',
        ),
        p(
          '只有用户要求时才 `jobs cancel`。排队和运行中会停并退积分。正在 persisting 时不能取消，错误码 `JOB_NOT_CANCELLABLE`。下载若目标已存在，是 `FILE_EXISTS`，换路径，不要删用户的文件。',
        ),
      ],
    },
    {
      id: 'exit-codes',
      title: '退出码和错误码',
      blocks: [
        table(
          ['退出码', '含义'],
          ['0', '成功。等待超时但任务还在，也是 0'],
          ['1', '未预期的错误'],
          ['2', '命令或请求不合法，含 USAGE'],
          ['3', '未登录，或登录待批准、被拒、过期'],
          ['4', '被拒绝，或任务失败、取消'],
          ['5', '积分不足、超过 max-credits，或当日额度用尽'],
          ['6', '临时错误，可以用同一幂等键重试'],
          ['7', '命令行太旧'],
        ),
        table(
          ['错误码', '怎么处理'],
          ['AUTH_REQUIRED / UNAUTHENTICATED', '看 auth status，再登录'],
          ['SERVICE_MISMATCH', '退出码 4。清变量或 --switch-service，不要另开登录'],
          ['AUTH_EXPIRED', '重新开始登录'],
          ['AUTH_PENDING', '再跑一次 auth login，继续这一轮'],
          ['AUTH_DENIED', '停。不要反复申请'],
          ['CREDENTIAL_STORE_UNWRITABLE', '退出码 4。让目录可写，或设置 MUVLOOM_CONFIG_DIR'],
          ['PLAN_REQUIRED', '退出码 4。4K 或 --quality high 都要会员。改成 1K/2K 或低/中画质'],
          [
            'INSUFFICIENT_CREDITS / QUOTA_EXCEEDED / MAX_CREDITS_EXCEEDED',
            '退出码 5。告诉用户，不要重试',
          ],
          ['IDEMPOTENCY_CONFLICT', '换一个幂等键'],
          [
            'INVALID_REQUEST / MODEL_UNAVAILABLE / NOT_FOUND',
            '改参数、重新 capabilities，或核对 id',
          ],
          ['JOB_FAILED / JOB_CANCELED', '看任务说明'],
          ['JOB_NOT_CANCELLABLE', '已经在保存，不能取消'],
          ['FILE_EXISTS', '换下载路径'],
          [
            'RATE_LIMITED / NETWORK_ERROR / TEMPORARILY_UNAVAILABLE / INTERNAL_ERROR',
            '退出码 6。稍后用同一步骤重试',
          ],
          ['CAPABILITY_UNAVAILABLE', '命令行要同时开着 cli:api 和 accounts:sync。缺一个就是这个码'],
          [
            'UNSUPPORTED_VERSION',
            '退出码 7。客户端太旧或 schema 对不上。服务端当前的最低版本常量是 0.1.0。auth status 本地比较出 outdated 时也要重装。UPGRADE_REQUIRED 只在命令行映射表里，服务端错误表没有这一码',
          ],
          [
            'FORBIDDEN / CONFLICT / MEDIA_NOT_READY / REQUEST_TOO_LARGE',
            '退出码 4。不要重试同一份过大的文件或未就绪的素材',
          ],
          ['USAGE', '看该命令的 --help'],
        ),
      ],
    },
    {
      id: 'plugin-faq',
      title: '常见问题',
      blocks: [
        faq(
          {
            q: '能不能用 npm 装？',
            a: '不能。没有官方的 @muvloom/cli。用上面的安装脚本。',
          },
          {
            q: '要不要把验证码发给智能体？',
            a: '不要。命令行自己打开批准页，你在浏览器里点批准。不要发送密码、验证码、Cookie 或令牌。',
          },
          {
            q: 'SSH 里没有浏览器怎么办？',
            a: '设置 MUVLOOM_NO_BROWSER=1，用 auth login --no-wait，在自己的电脑打开打印出来的链接。',
          },
          {
            q: '等待超时是不是失败了？',
            a: '不是。jobs wait 超时只表示这次没等到结束。用同一个任务 id 继续等。',
          },
          {
            q: '技能菜单里看不到？',
            a: '刷新宿主的会话。不要编一个别的斜杠名字。WorkBuddy 和豆包不要用 --host。',
          },
        ),
        p(
          `维护命令的实现在 cli-go/internal/cli。网页接入在 apps/web/src/features/cli 和 apps/web/public/cli。服务端在 apps/bff/src/routes/cli.ts。联系 ${SUPPORT_CONTACT.email} 时说明版本号和错误码即可。`,
        ),
      ],
    },
  ],
  related: ['create/gpt-image-26', 'account/credits', 'account/membership'],
}

export const faqPage: GuidePage = {
  id: 'faq',
  title: '常见问题',
  summary: '登录、积分、动图、会员和命令行里最常卡住的几件事。',
  meta: {
    title: '常见问题 - 幕芽 Muvloom 使用指南',
    description: '幕芽使用中的登录、生成失败、GIF、会员和插件问题。',
  },
  updated,
  intro: [p('先看报错原文，再对照下面的处理。不要连点重试。')],
  sections: [
    {
      id: 'faq',
      title: '问答',
      blocks: [
        faq(
          {
            q: '点击发送后弹出登录窗口，没有开始生成？',
            a: '生成需要登录。登录完成并回到原页面后，再点一次生成。关闭登录框不会自动补发。',
          },
          {
            q: '提示积分不够或额度用尽？',
            a: '这一单没有生成。充值、等待额度重置，或减少张数和清晰度。不要连续点发送。',
          },
          {
            q: '卡片写生成服务异常、本次未能完成？',
            a: '上游没有出图。积分会按失败退回。可以稍后用同一设置再试一次。不要改用别的模型冒充原来的格式，例如用 2.5 的静图代替 2.6 的 GIF。',
          },
          {
            q: '动图 GIF 是灰的？',
            a: '先确认模型是 Image 2.6，并且没有参考图。有参考图时动图和矢量不可用。菜单里没有 2.6，就是当前环境没开。',
          },
          {
            q: '选了中等质量，卡片上却写着 low？',
            a: '以生成设置里点过的质量和当次扣费为准。缩略图旁的单词若和设置不一致，打开该次详情看格式、尺寸和模型，不要只看这一个词。',
          },
          {
            q: '4K 或高画质点不了？',
            a: '非会员最高 2K，高画质是会员专享。命令行返回 PLAN_REQUIRED。改小尺寸，或开通会员后再选。',
          },
          {
            q: '智能改图是灰的？',
            a: '看悬停原因：模型不支持遮罩、图太小，或长宽比超过 3:1。换成 GPT Image 系列或换一张图。不要改用整图编辑假装只改了一块。',
          },
          {
            q: '探索里没有案例？',
            a: '页面会写没有符合条件的灵感。换分类或清掉筛选。不要从别的环境拷图充数。',
          },
          {
            q: '命令行提示 SERVICE_MISMATCH？',
            a: '环境变量里的 API 和已经保存的登录不是同一个服务。清掉变量，或在确定要换时使用 auth login --switch-service。',
          },
          {
            q: '等待命令超时了，图还要不要？',
            a: '要。超时不是失败。用同一个任务 id 继续 jobs wait，不要用新的请求再扣一次。',
          },
        ),
      ],
    },
    {
      id: 'contact',
      title: '联系',
      blocks: [
        p('附上截图、大致时间和错误码，不要附密码、验证码或令牌。'),
        list(`邮箱：[${SUPPORT_CONTACT.email}](${SUPPORT_MAILTO})`),
      ],
    },
  ],
  related: ['start/overview', 'account/credits', 'plugins/cli'],
}
