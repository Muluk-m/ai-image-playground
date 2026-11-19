import { SUPPORT_CONTACT, SUPPORT_MAILTO } from '@image-playground/shared/support-contact'
import { installScriptCommands } from '../../../cli/connectAgents'
import { faq, type GuidePage, list, note, p, prompt, steps, table, tip, warn } from '../../model'
import { demo, still, workbuddyFilm } from '../media'

const unixInstall = installScriptCommands('unix', 'https://muvloom.online').join('\n')
const windowsInstall = installScriptCommands('windows', 'https://muvloom.online').join('\n')

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
          '图片模型清单里的基础价，测试环境里 Image 2.5、多数静态模型是每张 100 量级，Gemini 各档不同。这是单价。质量、分辨率和编辑会乘倍率。Image 2.5 只按分辨率加价，低、中、高画质同价，局部编辑按 1K 计，见第一张表。GPT Image 2.6 的实际积分是第二张表。两张表里 Flare 与 Sunburst 都相同。',
        ),
        table(['2.5 静态图', '积分'], ['1K', '100'], ['2K', '120'], ['4K', '150']),
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
  title: '在 WorkBuddy 里生成第一张图',
  summary: '让 WorkBuddy 安装幕芽技能，在浏览器里授权，再到对话和幕芽作品库查看同一张咖啡海报。',
  meta: {
    title: '在 WorkBuddy 里生成第一张图 - 幕芽 Muvloom 使用指南',
    description:
      '让 WorkBuddy 安装幕芽技能，在浏览器里授权，再到对话和幕芽作品库查看同一张咖啡海报。',
  },
  updated: '2026-11-19',
  intro: [
    workbuddyFilm(
      'WorkBuddy 幕芽插件完整使用教程',
      '安装、浏览器授权、生成，再到 WorkBuddy 和幕芽作品库查看同一张图。',
    ),
  ],
  sections: [
    {
      id: 'install',
      title: '把安装提示词发给 WorkBuddy',
      blocks: [
        steps(
          '打开幕芽的[插件集成](/connect)，选 [[WorkBuddy]]。',
          '在 [[让 Agent 安装]] 下点击 [[复制提示词]]。',
          '在 WorkBuddy 新建任务，粘贴并发送整段提示词。等它装好幕芽技能并发起账号连接。',
        ),
      ],
    },
    {
      id: 'skill-login',
      title: '在浏览器里确认授权',
      blocks: [
        steps(
          '打开 WorkBuddy 发起的授权页面。如果浏览器没有自动打开，点击对话里的授权链接。',
          '登录你要用来保存作品的幕芽账号。核对页面上列出的权限，点击 [[授权]]。',
          '看到连接成功的提示后，回到 WorkBuddy，等它确认幕芽已就绪。下次使用会沿用这次连接。',
        ),
      ],
    },
    {
      id: 'commands',
      title: '用一句话生成咖啡海报',
      blocks: [
        p('在 WorkBuddy 新建任务，输入 `/muv`，从技能菜单选中 `muvloom`，再发送下面这段话。'),
        prompt(
          '咖啡海报',
          '生成一张竖版咖啡海报。奶油白的背景上放一把橘红色摩卡壶，旁边是一杯冰拿铁，午后阳光从侧面照进来。画面不要文字。只做一张，1K，生成后直接展示。',
        ),
        note('生图会消耗当前幕芽账号的积分。'),
      ],
    },
    {
      id: 'jobs',
      title: '在两边打开同一张图',
      blocks: [
        steps(
          '在 WorkBuddy 的任务对话里，点开刚生成的海报。',
          '回到幕芽，用刚才授权的账号打开[资产](/assets)，在 [[作品]] 里找到这张海报，点开即可看大图。',
        ),
      ],
    },
    {
      id: 'service',
      title: '在其他 Agent 里使用',
      blocks: [
        p(
          '打开[插件集成](/connect)，切到豆包工作、Claude Code、Codex 或其他客户端，复制对应的安装提示词发给它。',
        ),
      ],
    },
    {
      id: 'plugin-faq',
      title: '安装后搜不到技能？',
      blocks: [
        p(
          '先开一个新任务，再输入 `/muv`。如果菜单仍然没有 `muvloom`，重启 WorkBuddy，在新任务里再试一次。',
        ),
      ],
    },
    {
      id: 'exit-codes',
      title: '网页上找不到作品？',
      blocks: [
        p(
          '先确认 WorkBuddy 里的任务已经完成，再核对网页账号，刷新 [[资产]] 的 [[作品]] 页签。还在排队时，可以让 WorkBuddy 查询刚才的任务进度。',
        ),
      ],
    },
    {
      id: 'not-npm',
      title: '手动安装命令行',
      blocks: [
        p(
          '需要自己操作终端时，下面两条命令任选与你系统对应的一条。使用其他幕芽站点时，到该站点的[插件集成](/connect)选择 [[我自己来]]，复制对应命令。',
        ),
        prompt('macOS / Linux', unixInstall),
        prompt('Windows PowerShell', windowsInstall),
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
