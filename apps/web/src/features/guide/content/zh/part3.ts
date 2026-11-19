import { SUPPORT_CONTACT, SUPPORT_MAILTO } from '@image-playground/shared/support-contact'
import {
  CLI_MIN_VERSION,
  CLI_VERSION,
  installScriptCommands,
  SESSION_PATH,
} from '../../../cli/connectAgents'
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
  title: '插件与命令行',
  summary:
    '把幕芽接入 WorkBuddy、豆包工作、Claude Code、Codex 与其他 Agent，或直接在终端运行 muvloom 命令出图。',
  meta: {
    title: '插件与命令行：WorkBuddy、豆包工作、Claude Code 与 Codex - 幕芽 Muvloom 使用指南',
    description: `在 WorkBuddy、豆包工作、Claude Code、Codex 与终端中使用幕芽：WorkBuddy 视频教程、各客户端安装与授权、muvloom CLI ${CLI_VERSION} 命令、任务等待与错误排查。`,
  },
  updated: '2026-11-19',
  intro: [
    p(
      `幕芽插件由本机的原生命令行 \`muvloom\`（当前发布 ${CLI_VERSION}）与装进客户端的官方技能组成。工作台的[插件集成](/connect)支持 **WorkBuddy**、**豆包工作**、**Claude Code**、**Codex** 以及其他支持技能的 Agent。你可以在客户端里用自然语言或 \`/muv\` 出图，也可以直接在终端调用 \`muvloom\`；生成的作品会同步到当前幕芽账号的[资产](/assets)中。`,
    ),
    workbuddyFilm(
      'WorkBuddy 幕芽插件完整使用教程',
      '视频演示：在 WorkBuddy 中发送安装提示词、浏览器确认授权、生成咖啡海报，并在对话与幕芽作品库查看同一张图。',
    ),
  ],
  sections: [
    {
      id: 'install',
      title: '支持的客户端与接入方式',
      blocks: [
        p(
          '打开幕芽工作台的[插件集成](/connect)，顶部可以切换客户端。每个客户端都提供 [[让 Agent 安装]] 和 [[我自己来]] 两种方式：前者把一段提示词发给 Agent 由它自动完成安装和授权；后者由你在终端执行安装命令并导入技能。',
        ),
        table(
          ['客户端', '让 Agent 安装', '手动安装技能', '对话调用方式'],
          [
            'WorkBuddy',
            '复制提示词发给 WorkBuddy（按 `/cli/workbuddy.md` 自动下载技能包并安装到 `~/.workbuddy/skills/muvloom/`）',
            '在 `/connect` 下载 `muvloom-workbuddy.zip`，从 WorkBuddy「添加技能 → 上传技能」导入',
            '新建任务输入 `/muv`，选中 `muvloom`',
          ],
          [
            '豆包工作',
            '复制提示词发给豆包工作（按 `/cli/doubao.md` 在对话中导入技能包）',
            '在 `/connect` 下载 `muvloom-doubao.zip`，从「插件·技能·伙伴 → 技能 → +添加 → 上传技能」导入',
            '新建工作任务输入 `/muv`，或输入 `/`、`@` 搜索 `muv` / `幕芽`',
          ],
          [
            'Claude Code',
            '复制提示词发给 Claude Code（按 `/cli/setup.md` 自动执行）',
            '运行 `muvloom skill install --host claude-code`（装到 `~/.claude/skills/muvloom`）',
            '输入 `/muv` 或 `/muvloom`',
          ],
          [
            'Codex',
            '复制提示词发给 Codex（按 `/cli/setup.md` 自动执行）',
            '运行 `muvloom skill install --host codex`（装到 `~/.agents/skills/muvloom`）',
            '输入 `/` 或 `/skills` 选 Muvloom，或用 `$muvloom`',
          ],
          [
            '其他 Agent',
            '切到 [[其他]] 复制通用提示词',
            '下载 `/cli/muvloom-skill.zip`（或运行 `muvloom skill install --host generic --output <目录>` 导出技能目录），放入宿主技能目录或从界面上传',
            '输入 `/muv` 或直接说「用幕芽生成…」',
          ],
        ),
        note(
          '`muvloom skill install --host` 只接受 `claude-code`、`codex`（可选 `--scope user|project`，默认 `user`）以及用于导出通用技能目录的 `generic`（可配 `--output <目录>`）。WorkBuddy 和豆包工作走各自客户端的专用技能包导入，不要传 `--host workbuddy` 或 `--host doubao`。',
        ),
      ],
    },
    {
      id: 'skill-login',
      title: '完整教程：以 WorkBuddy 为例跑通第一张图',
      blocks: [
        p(
          '如果你第一次接入，可以跟着页首视频，按下面四步走通从安装、浏览器授权到两端看图的全流程。豆包工作、Claude Code 和 Codex 的授权与查图步骤完全相同。',
        ),
        steps(
          '**发送安装提示词**：打开幕芽[插件集成](/connect)，选 [[WorkBuddy]]，在 [[让 Agent 安装]] 下点击 [[复制提示词]]。到 WorkBuddy 新建任务，粘贴并发送整段提示词，等它装好幕芽技能并发起账号连接。',
          '**浏览器确认授权**：WorkBuddy 会调起系统默认浏览器打开授权页（`/device`）；若未自动弹出，点击对话里的授权链接。登录你要保存作品的幕芽账号，核对权限后点击 [[授权]]。看到连接成功后回到客户端，等它确认就绪。',
          '**一句话生成海报**：在 WorkBuddy 新建任务，输入 `/muv` 并从菜单选中 `muvloom`，发送下方的咖啡海报提示词。',
          '**在两端查看结果**：生成完成后，在 WorkBuddy 回复里直接点开海报；同时回到幕芽网页打开[资产](/assets)，在 [[作品]] 页签下也能看到并下载同一张图。',
        ),
        prompt(
          '咖啡海报示例',
          '生成一张竖版咖啡海报。奶油白的背景上放一把橘红色摩卡壶，旁边是一杯冰拿铁，午后阳光从侧面照进来。画面不要文字。只做一张，1K，生成后直接展示。',
        ),
        note(
          '授权码有效期 20 分钟，只通过浏览器 `/device` 页面批准。不要把账号密码、邮箱验证码、Cookie 或令牌发进任何 Agent 对话。生图会消耗当前连接账号的积分。',
        ),
      ],
    },
    {
      id: 'not-npm',
      title: `手动安装命令行（${CLI_MIN_VERSION} 或更新）`,
      blocks: [
        p(
          `需要自己操作终端时，在[插件集成](/connect)切到 [[我自己来]]，或直接运行下方与你系统对应的命令。\`muvloom\` 是单个原生二进制（支持 macOS arm64/x64、Linux x64/arm64、Windows x64），不需要安装 Node、npm 或 Python，也没有 \`@muvloom/cli\` 这个 npm 包。`,
        ),
        p(
          `安装命令会从当前站点下载 \`install.sh\` 或 \`install.ps1\`，先校验页面公布的 SHA-256，再以 \`MUVLOOM_MIN_VERSION=${CLI_MIN_VERSION}\` 安装或原地升级。不要把脚本直接管道进 \`sh\` 或 \`iex\`，也不要用 \`MUVLOOM_VERSION\` 钉死旧版本。原地升级会保留已有的登录连接。`,
        ),
        prompt('macOS / Linux', unixInstall),
        prompt('Windows PowerShell', windowsInstall),
        list(
          `**安装位置**：macOS / Linux 优先替换已在 PATH 上且可写的 \`muvloom\`，否则装到免 sudo 可写的 \`/usr/local/bin\`，再否则装到 \`~/.local/bin\`（Windows 默认在 \`%LOCALAPPDATA%\\Programs\\muvloom\`）。可用 \`MUVLOOM_INSTALL_DIR\` 自定义。`,
          `**刷新当前终端 PATH**：首次安装后若紧接着运行 \`muvloom\` 提示找不到命令，先在当前终端执行 \`${SESSION_PATH.unix}\`（Windows 执行 \`${SESSION_PATH.windows}\`），或新开一个终端窗口。`,
          '**装技能并登录**：Claude Code / Codex 接着运行 `muvloom skill install --host claude-code`（或 `codex`），最后运行 `muvloom auth login` 在浏览器完成授权。',
        ),
      ],
    },
    {
      id: 'service',
      title: '多站点服务地址与远程无浏览器登录',
      blocks: [
        p(
          '如果你从[插件集成](/connect)复制提示词，里面已经带了当前站点的地址，Agent 会自动连对服务。只有在你自己操作终端、或同一台机器需要在生产站、企业站与测试站之间切换时，才需要关注 `MUVLOOM_API_URL`。',
        ),
        table(
          ['你打开的幕芽站点', '对应的 MUVLOOM_API_URL'],
          ['https://muvloom.online', 'https://api.muvloom.online（默认）'],
          ['https://image.nainma.online', 'https://api.muvloom.online'],
          ['https://image-playground.qiliangjia.one', 'https://image-api.qiliangjia.one'],
          ['https://test.muvloom.online', 'https://test-api.muvloom.online'],
        ),
        list(
          '**切换服务**：连接成功后服务地址会保存在本地，日常命令不需要每次带环境变量。如果当前环境变量与已保存的连接不一致，`muvloom auth status` 退出码仍为 `0` 并在结果中返回 `state: "service_mismatch"`（需读取 `state` 字段判断），而其他需要鉴权的命令会报错 `SERVICE_MISMATCH`（退出码 `4`）。清掉环境变量即可沿用原连接；确认要换站点时运行 `muvloom auth login --switch-service`。',
          '**SSH / 云端无浏览器环境**：豆包工作云端环境、远程服务器或容器里打不开本地浏览器时，设置 `MUVLOOM_NO_BROWSER=1` 并运行 `muvloom auth login --no-wait`，把打印出来的完整链接复制到你电脑的默认浏览器里打开并点 [[授权]]，再回到终端运行 `muvloom auth login --timeout 30` 完成连接。',
          '**配置与凭据存储**：默认优先存系统钥匙串；钥匙串不可用时自动退回配置目录下的 `credentials.json`（`auth status` 显示 `credential_store: file`，不属于报错）。可用 `MUVLOOM_CONFIG_DIR` 指定独立配置目录，或设 `MUVLOOM_CREDENTIALS_STORE=file` 强制使用文件存储。',
        ),
      ],
    },
    {
      id: 'commands',
      title: '常用命令与生图参数',
      blocks: [
        p(
          '在 Agent 对话里，你只需要用自然语言描述画面、比例、模型和本地参考图路径，技能会自动拼好下面的命令。如果你在终端自己运行或写脚本，可以直接调用 `muvloom`（所有子命令都支持 `--json` 输出结构化结果）：',
        ),
        table(
          ['命令', '用途'],
          [
            'muvloom auth login [--no-wait] [--timeout 秒] [--switch-service]',
            '发起或继续设备码登录授权',
          ],
          ['muvloom auth status / auth logout', '查看连接状态、当前服务与可用积分；或撤销本机连接'],
          ['muvloom capabilities', '列出当前账号可用的模型、分辨率档位、GIF/SVG 限制与基础单价'],
          ['muvloom images validate --prompt TEXT', '预检参数并计算积分报价，不创建任务、不扣费'],
          ['muvloom images create --prompt TEXT', '提交静态图、动图 GIF 或矢量 SVG 生成任务'],
          [
            'muvloom jobs list | get | wait | cancel',
            '查询任务列表、单条详情、等待完成或取消排队中的任务',
          ],
          ['muvloom artifacts get | download', '查看或下载已生成的结果文件'],
          ['muvloom media upload | list | get | download', '上传或管理参考图素材'],
          [
            'muvloom skill install | status',
            '为 Claude Code / Codex 安装技能，或用 `--host generic` 导出通用技能包；检查技能状态',
          ],
          ['muvloom update check / version', '检查是否有新版本；打印当前 CLI 版本号'],
        ),
        p(
          '`images create` 与 `images validate` 共用生成参数：`--prompt`（或 `--prompt-file`）、`--model`、`--aspect-ratio`、`--image-size`（只填 `1K`、`2K`、`4K`，不要写像素值）、`--quality`（`low`、`medium`、`high`）、可重复传入的 `--ref <本地图片路径>`、`--max-credits <积分上限>`，以及 Image 2.6 专用的 `--output-format gif|svg`、`--frames`、`--frame-duration-ms`、`--frame-size`。`create` 额外支持 `--wait <秒>`（默认 `0`，即提交后立即返回；需要等待完成或自动执行 `--download` 时必须显式传入正整数等待秒数，最大 `3600`）、`--download <目录>` 和 `--idempotency-key`。',
        ),
        prompt(
          '终端生成静态图并下载到 ./out',
          'muvloom images create --prompt "奶油白背景上的橘红色摩卡壶与冰拿铁，午后侧光，商业海报" --aspect-ratio 3:4 --image-size 1K --wait 300 --download ./out',
        ),
        prompt(
          '带本地参考图改图（自动上传参考图）',
          'muvloom images create --prompt "保留商品外形与商标，把背景换成极简浅灰石台，自然阴影" --ref ./product.png --aspect-ratio 1:1 --wait 300 --download ./out',
        ),
        prompt(
          '用 Image 2.6 生成循环 GIF 与只报价不扣费',
          'muvloom images create --model gpt-image-2.6-flare --output-format gif --frames 8 --prompt "一只橘猫对着镜头挥手，循环贴纸，白底" --wait 300 --download ./out\nmuvloom images validate --prompt "a poster" --image-size 4K',
        ),
        warn(
          '命令行一次 `images create` 只生成 1 张图，没有 `--n` 批量参数，也没有视频生成子命令（视频请到网页画布提交）。生成 GIF 或 SVG 时不要传 `--ref`、`--aspect-ratio`、`--image-size` 或 `--quality`；GIF 帧数范围是 2–16，但 768 尺寸配 16 帧会超出拼图上限被拒，具体上限以 `muvloom capabilities` 返回的 `gif.max_frames_by_size` 为准。',
        ),
      ],
    },
    {
      id: 'jobs',
      title: '任务状态、等待超时与多端同步',
      blocks: [
        p(
          '任务提交后会依次经过 `queued`（排队）→ `running`（生成中）→ `persisting`（保存作品）→ `succeeded`（完成，或 `failed` / `canceled`）。所有已完成的任务都会同步到幕芽网页[资产](/assets)的 [[作品]] 页签；在[插件集成](/connect)底部还能查看各设备的最近使用时间或随时 [[撤销连接]]。CLI 只有在 `images create` 同时显式传入正数 `--wait` 与 `--download <目录>`、且在等待时间内变成 `succeeded` 时才会自动把结果下载到本地（`jobs wait` 本身只等待状态、不下载文件，完成后需用 `muvloom artifacts download <artifact-id>` 保存）。',
        ),
        list(
          '**等待超时不是失败**：`muvloom jobs wait` 默认等待 300 秒。如果到时间还没出完，返回结果里的 `wait_timed_out` 为 `true`、退出码仍是 `0`，代表任务还在后台跑。直接对同一个任务 ID 继续运行 `muvloom jobs wait <job-id>` 即可，等到 `succeeded` 后再用结果中 `job.artifacts` 里的 ID 运行 `muvloom artifacts download <artifact-id> --output <路径>` 下载文件；**切勿重新运行 `images create`**，否则会新建任务并再扣一次积分。',
          '**幂等防重扣**：使用同一个 `--idempotency-key`（8–64 位字母、数字、`_`、`.`、`:`、`-`）重发 `images create` 会直接返回原任务，不会重复扣费。未显式传入时 CLI 每次都会生成新的随机键，并保存在输出或临时错误详情的 `idempotency_key` 字段中；若请求中途断线，先用 `muvloom jobs list --idempotency-key <KEY>` 查询或带上该键重试，不要无键直接重跑原命令。',
          '**取消与退款**：只有在排队（`queued`）或生成中（`running`）运行 `muvloom jobs cancel <job-id>` 才能取消并退回积分；一旦进入 `persisting` 阶段就不能取消（返回 `JOB_NOT_CANCELLABLE`）。',
          '**本地文件保护**：下载结果时如果目标路径已存在同名文件，CLI 会先比对文件内容：字节完全相同时直接视为成功（返回 `already_present: true`，方便中断后安全重跑下载）；只有内容不同时才会报 `FILE_EXISTS`（退出码 `4`）并停止，不会覆盖你原有的其他文件。',
        ),
      ],
    },
    {
      id: 'exit-codes',
      title: '退出码与常见错误码速查',
      blocks: [
        p('脚本或 Agent 可以根据退出码和 `--json` 里的 `error.code` 判断下一步动作：'),
        table(
          ['退出码', '含义', '处理方式'],
          ['0', '成功（含 `jobs wait` 超时但任务仍在运行）', '超时则继续 `jobs wait` 同一任务 ID'],
          ['1', '未预期的内部错误', '查看报错信息或加 `--json` 排查'],
          [
            '2',
            '命令行参数或请求校验不合法（`USAGE`、`INVALID_REQUEST`）',
            '执行 `--help` 或检查参数组合与本地参考图路径',
          ],
          ['3', '未登录、等待授权中、授权被拒或已过期', '先跑 `auth status`，按状态继续或重新登录'],
          ['4', '请求被服务端拒绝，或任务失败 / 已取消', '修改参数后再试，不要原样死循环重试'],
          [
            '5',
            '积分不足、超出 `--max-credits` 或当日额度用尽',
            '停止重试；充值、调大上限或等额度重置',
          ],
          [
            '6',
            '网络或服务暂时不可用',
            '只读命令可直接重试；`images create` 须复用输出/错误详情中的 `idempotency_key`（或已有 `job_id` 时改跑 `jobs wait`）',
          ],
          ['7', 'CLI 版本过旧', '回到 `/connect` 重新执行安装命令升级'],
        ),
        table(
          ['常见错误码', '原因与解决办法'],
          [
            'AUTH_REQUIRED / UNAUTHENTICATED',
            '当前未登录或连接已被撤销（退出码 3）。先运行 `muvloom auth status`，再运行 `muvloom auth login`。',
          ],
          [
            'AUTH_PENDING',
            '浏览器里的授权还没点完（退出码 3）。再跑一次 `muvloom auth login` 会接着同一次登录等待，不会新开页面。',
          ],
          [
            'AUTH_EXPIRED / AUTH_DENIED',
            '`AUTH_EXPIRED` 表示 20 分钟设备码过期，重新执行 `auth login`；`AUTH_DENIED` 表示用户点了拒绝，停止重试（均为退出码 3）。',
          ],
          [
            'SERVICE_MISMATCH',
            '环境变量 `MUVLOOM_API_URL` 与已保存连接的服务不一致（除 `auth status` 返回退出码 0 和 `state: "service_mismatch"` 外，其余需连接命令均为退出码 4）。清掉该环境变量，或用 `muvloom auth login --switch-service` 切换。',
          ],
          [
            'PLAN_REQUIRED',
            '`--image-size 4K` 与 `--quality high` 需要会员（退出码 4）。非会员请改用 `1K` / `2K` 及 `low` / `medium` 画质。',
          ],
          [
            'INSUFFICIENT_CREDITS / QUOTA_EXCEEDED / MAX_CREDITS_EXCEEDED',
            '积分余额不足、当日额度用尽，或报价高于你传入的 `--max-credits`（退出码 5）。不要自动重试。',
          ],
          [
            'INVALID_REQUEST',
            '请求参数组合不合法或本地参考图无法读取/格式不支持（退出码 2）。先跑 `muvloom capabilities` 核对支持的模型与格式。',
          ],
          [
            'MODEL_UNAVAILABLE / REQUEST_TOO_LARGE',
            '模型当前未开放，或参考图超过 50MB 上限（退出码 4）。更换可用模型或压缩参考图后再提交。',
          ],
          [
            'RATE_LIMITED / NETWORK_ERROR / TEMPORARILY_UNAVAILABLE',
            '短暂限流或网络波动（退出码 6）。只读查询稍后直接重试；`images create` 重试时必须传错误详情里的 `--idempotency-key`（若已返回 `job_id` 则直接 `jobs wait`）。',
          ],
          [
            'UNSUPPORTED_VERSION',
            'CLI 版本低于服务端要求（退出码 7）。用上方的安装脚本原地升级到最新版本。',
          ],
        ),
      ],
    },
    {
      id: 'plugin-faq',
      title: '常见问题排查',
      blocks: [
        faq(
          {
            q: '安装完成后，在客户端输入 /muv 搜不到幕芽技能？',
            a: '先新建一个任务再输入 /muv（豆包工作也可以输入 / 或 @ 搜索 muv、幕芽）。如果菜单里仍然没有 muvloom，请完整退出并重启客户端（WorkBuddy、豆包工作、Claude Code 或 Codex），在新任务里再试一次。不要自己编造未注册的斜杠命令。',
          },
          {
            q: '在 Agent 里生成了图片，但在幕芽网页上找不到？',
            a: '先确认 Agent 里的生成任务已经变成 succeeded（还在排队或生成中时可以让 Agent 查询任务进度）。然后核对网页右上角登录的账号是否与刚在浏览器 /device 页面授权的账号一致，一致的话刷新「资产 → 作品」页签即可看到。',
          },
          {
            q: '能不能用 npm install 或 npx 安装 muvloom？',
            a: '不能。官方没有发布 @muvloom/cli 这个 npm 包，请始终使用 /connect 页面或本页提供的校验安装脚本安装原生二进制。',
          },
          {
            q: '授权页面没有自动打开，或者我在远程服务器 / 云端 Agent 里怎么授权？',
            a: '点击对话里打印的完整授权链接（包含 user_code），在你电脑的系统默认浏览器中打开并点「授权」。在 SSH 或云端环境里，可以用 MUVLOOM_NO_BROWSER=1 muvloom auth login --no-wait 获取链接，授权后再跑 muvloom auth login --timeout 30 完成连接。',
          },
          {
            q: '想要断开某台电脑或某个 Agent 的连接，或者卸载 CLI 怎么做？',
            a: '在终端运行 muvloom auth logout，或在幕芽网页打开「插件集成」在「已连接的插件」列表里点击「撤销连接」。如果要彻底卸载，退出登录后删掉 which muvloom 指向的二进制文件、清理 shell 配置文件里追加的 PATH 行，并按需删除配置目录即可。',
          },
        ),
        p(
          `给智能体自动执行的原始安装说明位于 \`/cli/setup.md\`、\`/cli/workbuddy.md\` 和 \`/cli/doubao.md\`。遇到无法解决的问题时，记下 \`muvloom version\` 输出的版本号、错误码和大致时间，发邮件至 [${SUPPORT_CONTACT.email}](${SUPPORT_MAILTO})（切勿附带密码或令牌）。`,
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
