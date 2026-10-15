/** Popular briefs ship with the skill catalog. "自动" leaves that choice to the writer. */
export const SCRIPT_BRIEF_AUTO = '自动'

export interface ScriptCharacter {
  readonly name: string
  readonly description: string
  readonly kind: 'person' | 'location' | 'prop'
}

export interface ScriptBrief {
  readonly id: string
  readonly title: string
  readonly coverUrl?: string
  readonly genre: string
  readonly audience: string
  readonly era: string
  readonly hook: string
  readonly style: string
  readonly structure: string
  readonly episodes: string
  readonly outline: string
  readonly characters: readonly ScriptCharacter[]
  readonly episode1: string
}

export const SCRIPT_BRIEFS: readonly ScriptBrief[] = [
  {
    id: 'sprout-window',
    title: '窗台萌芽',
    coverUrl: '/api/agent/skills/look-amber-resin/files/cover.webp',
    genre: '都市现实',
    audience: '刚开始独自生活的人',
    era: '当代',
    hook: '一盆快枯的绿植，在最后一次浇水前开口说话',
    style: '暖色日常，窗光',
    structure: '单元小故事',
    episodes: '1',
    outline:
      '林夏把一盆枯萎的绿植留在窗台，准备丢掉。夜里绿植开口，只要她答应每天给它讲一件今天的小事，它就重新长出一片叶子。第一集她讲了加班，叶子没有动；她改口讲了楼下那只总等她的猫，新叶才展开。',
    characters: [
      {
        kind: 'person',
        name: '林夏',
        description: '租住在旧公寓的插画师，说话很轻，袖口总沾着颜料。',
      },
      {
        kind: 'location',
        name: '旧公寓窗台',
        description: '朝东的窄窗台，清晨有一块暖光，花盆边缘有干涸的水渍。',
      },
      {
        kind: 'prop',
        name: '萌芽',
        description: '几乎秃掉的小绿植，新叶是半透明的嫩绿，只会在真话之后生长。',
      },
    ],
    episode1:
      '清晨。林夏把花盆端到门口，又停住。萌芽用很轻的声音说：讲一件今天真实发生的事。她先讲了通宵改稿，叶子纹丝不动。楼道里那只黄猫又坐在鞋垫上。她蹲下去，说昨天也是它在等。窗台上展开第一片新叶。',
  },
  {
    id: 'last-train',
    title: '末班地铁',
    coverUrl: '/api/agent/skills/look-seaview-hotel/files/cover.webp',
    genre: '都市现实',
    audience: '下班后还在赶路的人',
    era: '当代',
    hook: '末班车上只剩两个人，其中一个记得对方明天会忘记今晚',
    style: '冷色车厢，少量暖光',
    structure: '双人对话',
    episodes: '1',
    outline:
      '周宁每天坐末班地铁。今晚对面的乘客陈麦认出她，并说自己记得一段她还不记得的明天。第一集不解释超能力从哪来，只让陈麦用一个只有周宁知道的细节证明自己，再把选择留到车门打开。',
    characters: [
      {
        kind: 'person',
        name: '周宁',
        description: '夜班编辑，耳机线打结，习惯在末班车上改最后一条标题。',
      },
      { kind: 'person', name: '陈麦', description: '对面乘客，大衣口袋里有一张明天日期的地铁票。' },
      {
        kind: 'location',
        name: '末班车厢',
        description: '空荡的地铁车厢，荧光灯有一盏在闪，车窗全是隧道。',
      },
    ],
    episode1:
      '隧道里。周宁抬头，发现对面的人正看着自己的屏幕。陈麦说：明天这条标题你会删掉。她把电脑合上。他从口袋里掏出一张印着明天日期的票，背面是她只写在备忘录里的一句：别在这站下。到站铃声响起。',
  },
  {
    id: 'hill-sea',
    title: '山海学徒',
    coverUrl: '/api/agent/skills/look-rock-wall-marble/files/cover.webp',
    genre: '玄幻修仙',
    audience: '想看师徒短剧的人',
    era: '架空古代',
    hook: '学徒只能画出自己见过的神兽，而山门外有一只还没被命名',
    style: '水墨留白，少量石青',
    structure: '师徒三集起势',
    episodes: '3',
    outline:
      '画师学徒阿禾只能把见过的东西画活。师父不许她画山门外那只没有名字的兽。第一集她在雨夜看见兽的眼睛，画出半张，纸上的眼睛跟着她眨眼。师父发现后没有责骂，只把笔收回，说明天要她自己决定画完还是烧掉。',
    characters: [
      {
        kind: 'person',
        name: '阿禾',
        description: '山门画师学徒，左手有洗不掉的墨迹，不敢给没见过的东西起名。',
      },
      {
        kind: 'person',
        name: '师父',
        description: '白发画师，说话很少，笔筒里只留一支给学徒的笔。',
      },
      {
        kind: 'location',
        name: '山门画室',
        description: '靠崖的木画室，窗外是雾，墙边晾着未干的兽谱。',
      },
      {
        kind: 'prop',
        name: '未名兽',
        description: '只在雨里显现眼睛的兽，没有鳞片的定稿，纸上会跟着人眨眼。',
      },
    ],
    episode1:
      '雨夜。阿禾把窗纸掀开一条缝，雾里有一双眼睛。她落笔，只画了眼白。纸上的眼睛眨了一下。师父站在门边，把笔从她手里抽走，放到窗台上，说：活过来的东西，要由你决定留不留。',
  },
]

export function scriptBriefById(id: string): ScriptBrief | undefined {
  return SCRIPT_BRIEFS.find((brief) => brief.id === id)
}

const field = (value: string) => value.trim() || SCRIPT_BRIEF_AUTO

/** The text node keeps the chosen brief and the first episode together. */
export function renderScriptDocument(brief: ScriptBrief): string {
  const characters = brief.characters
    .filter((one) => one.name.trim())
    .map((one) => `- ${one.name.trim()}：${one.description.trim() || SCRIPT_BRIEF_AUTO}`)
    .join('\n')
  return [
    `# ${brief.title.trim() || SCRIPT_BRIEF_AUTO}`,
    '',
    `题材：${field(brief.genre)}`,
    `目标受众：${field(brief.audience)}`,
    `时代背景：${field(brief.era)}`,
    `核心看点：${field(brief.hook)}`,
    `画风：${field(brief.style)}`,
    `结构：${field(brief.structure)}`,
    `集数：${field(brief.episodes)}`,
    '',
    '## 大纲',
    field(brief.outline),
    '',
    '## 人物表',
    characters || `- ${SCRIPT_BRIEF_AUTO}`,
    '',
    '## 第 1 集',
    field(brief.episode1),
    '',
  ].join('\n')
}

/** Append one episode. Returns null when that episode heading is already present. */
export function appendScriptEpisode(script: string, episode: number, text: string): string | null {
  const heading = `## 第 ${episode} 集`
  if (script.includes(heading)) return null
  const body = text.trim()
  if (!body) return null
  return `${script.replace(/\s*$/, '')}\n\n${heading}\n${body}\n`
}
