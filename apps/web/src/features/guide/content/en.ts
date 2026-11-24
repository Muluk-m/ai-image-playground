import { SUPPORT_CONTACT, SUPPORT_MAILTO } from '@image-playground/shared/support-contact'
import { installScriptCommands, SESSION_PATH } from '../../cli/connectAgents'
import {
  faq,
  type GuideContent,
  type GuidePage,
  list,
  note,
  p,
  prompt,
  steps,
  table,
  tip,
  warn,
} from '../model'
import { GUIDE_PATHS } from '../paths'
import { demo, promoFilm, still, workbuddyFilm } from './media'

const unixInstall = installScriptCommands('unix', 'https://muvloom.online').join('\n')
const windowsInstall = installScriptCommands('windows', 'https://muvloom.online').join('\n')

const updated = '2026-11-10'
const ui = 'The recording shows the Chinese interface.'

const overview: GuidePage = {
  id: 'overview',
  title: 'Product and the creation page',
  summary: 'What Muvloom does, and where each control on the creation page sends the work.',
  meta: {
    title: 'Product and the creation page - Muvloom guide',
    description: 'The creation page, Explore, Assets, Toolbox and the CLI plugin.',
  },
  updated,
  intro: [
    p(
      'Muvloom is an online tool for images and video. You write a picture, pick a model and settings, and the result lands in My work or on a canvas. Reference images, batches, the agent, inpainting and local crops share one account. Credits are spent per job.',
    ),
    demo('01-first-image', 'A cold-brew photo from Image generation', ui),
  ],
  sections: [
    {
      id: 'interface',
      title: 'What is on the page',
      blocks: [
        p('After sign-in, Create is `/image`. You do not start by creating a project.'),
        steps(
          '**Sidebar**: Create, Explore, Assets, Toolbox, Plugin. Recent chats and canvases sit below. [[+]] starts a new one.',
          '**Mode**: bottom-left of the composer, labelled Choose a creation mode. The options are Agent, Image generation, Video generation and Canvas.',
          '**Model**: the current name, for example Image 2.5 Flare. The menu groups GPT, Banana, Grok and Agnes.',
          '**Settings**: a chip such as 1 or 3:4 · 1K · 1. Only changed values appear; Auto ratio is left out. Ratio, count, quality and format live here.',
          '**Send**: the round button. Its accessible name is Generate. Shortcut {{Ctrl}}{{Enter}}. On a new canvas it reads Start creating.',
        ),
        still('zh', 'overview', 'The creation page'),
      ],
    },
    {
      id: 'first-image',
      title: 'A first still',
      blocks: [
        steps(
          'Leave the mode on Image generation.',
          'Pick Image 2.5 Flare. Do not use Image 2.6 for this still. GIF and SVG have their own page.',
          'Open settings. Ratio 3:4, count 1, quality Medium. Changes apply at once; click outside to close. Do not pick High or 4K. Those are member tiers.',
          'Write subject, light and use. The recording uses a cold brew on pale stone, afternoon light, commercial photo.',
          'Press Generate. My work appears under the composer when the card finishes.',
        ),
        prompt('Example', '一杯冷萃咖啡放在浅色石台上，冰块透亮，午后自然光，商业摄影，3:4 竖构图'),
        note(
          'On the test account a 1K Image 2.5 still cost about 100 credits. The card sometimes prints the word low next to a Medium setting. Trust the settings chip and the ledger, not that one word.',
        ),
      ],
    },
    {
      id: 'view-results',
      title: 'Where results go',
      blocks: [
        list(
          'My work is under the composer, newest first.',
          'Assets is what you explicitly saved: files, prompts, templates.',
          'Agent results also appear in the chat. Video and canvas results live on a canvas project.',
          'A failed card states the reason. Not enough credits means the job never started.',
        ),
      ],
    },
    {
      id: 'sign-in',
      title: 'Account and the plugin',
      blocks: [
        p(
          'The credit button opens the account. Sign-in is email or Google, unless that origin only enables another provider. Open [Plugins and CLI](/guide/en/plugins/cli/) for the WorkBuddy video tutorial, setup across Doubao Work, Claude Code and Codex, and `muvloom` CLI commands.',
        ),
      ],
    },
  ],
  related: ['start/first-image', 'create/modes', 'create/settings'],
}

const firstImage: GuidePage = {
  id: 'first-image',
  title: 'Make the first image',
  summary: 'The shortest path from an empty composer to a file you can download.',
  meta: {
    title: 'Make the first image - Muvloom guide',
    description: 'Image generation with Image 2.5 Flare at 3:4.',
  },
  updated,
  intro: [
    p(
      'This page is one still, no reference image. The recording is the same clip as on the overview.',
    ),
  ],
  sections: [
    {
      id: 'prepare',
      title: 'Check four things',
      blocks: [
        table(
          ['Item', 'Use', 'Avoid'],
          ['Mode', 'Image generation', 'Agent, which may plan first'],
          ['Model', 'Image 2.5 Flare', 'Image 2.6, unless you want GIF or SVG'],
          ['Settings', '3:4, 1, Medium', 'High, 4K'],
          ['References', 'None', 'A reference changes the price to an edit'],
        ),
      ],
    },
    {
      id: 'write',
      title: 'The sentence',
      blocks: [
        p(
          'Write what can be seen: subject, surface, light, use, framing. Put exact lettering in quotes. Put restrictions at the end. A second equal subject usually steals the frame.',
        ),
      ],
    },
    {
      id: 'after',
      title: 'After Generate',
      blocks: [
        steps(
          'Do not press Generate again. A second press is a second charge.',
          'The card shows a timer, then a thumbnail, model name and pixel size.',
          'Download from the card. A red failure is not a low-quality image. There is no file.',
        ),
        warn(
          'If the card says the service failed, later successful cards are older jobs. Do not treat them as this result.',
        ),
      ],
    },
  ],
  related: ['start/overview', 'create/composer', 'create/settings'],
}

const modes: GuidePage = {
  id: 'modes',
  title: 'Creation modes',
  summary: 'Agent, image, video and canvas send the same sentence to different places.',
  meta: {
    title: 'Creation modes - Muvloom guide',
    description: 'What each creation mode does after you press Generate.',
  },
  updated,
  intro: [
    p(
      'The old label Quick generate is now Image generation. Switching mode keeps the text and reference images already in the composer.',
    ),
  ],
  sections: [
    {
      id: 'choose-mode',
      title: 'Four destinations',
      blocks: [
        table(
          ['Mode', 'After submit', 'Use when'],
          ['Image generation', 'A still in My work', 'The sentence is already specific'],
          ['Agent', 'A chat, sometimes a plan first', 'Count, style or a set is still open'],
          ['Video generation', 'A new canvas project', 'You want motion'],
          ['Canvas', 'A new canvas, first still on the board', 'You will mask or compare'],
        ),
        still('zh', 'modes', 'The creation-mode menu'),
        note(
          'On 2026-11-10 the test environment menu had Agent, Image generation and Canvas only. Video generation was absent. Do not record another model and call it video.',
        ),
      ],
    },
    {
      id: 'mode-compare',
      title: 'Which one',
      blocks: [
        list(
          'One product still: Image generation.',
          'Two covers and titles you have not written: Agent.',
          'Camera move: Video generation, when that option exists.',
          'Change only the glaze: Canvas, then inpaint.',
          'A finished card does not move onto a canvas by itself. Use Place on canvas.',
        ),
      ],
    },
  ],
  related: ['start/first-image', 'create/agent', 'canvas/basics'],
}

const composer: GuidePage = {
  id: 'composer',
  title: 'Composer and reference images',
  summary: 'How to write the prompt, upload a reference, and insert a real @ mention.',
  meta: {
    title: 'Composer and reference images - Muvloom guide',
    description: 'Prompts, uploads and @ mentions in the Muvloom composer.',
  },
  updated,
  intro: [
    p('The composer accessible name is Describe your idea. Thumbnails sit above the text.'),
    demo('02-reference-image', 'A mug reference becomes a new still via @图1', ui),
  ],
  sections: [
    {
      id: 'prompts',
      title: 'Prompts',
      blocks: [
        list(
          'One subject. A second object should be smaller and further away.',
          'Name the light: window, softbox, backlight.',
          'Quote any lettering, and say no other text.',
          'End with what must stay: logo, color, silhouette.',
        ),
        prompt(
          'With a reference',
          '把 @图1 的杯子放在干净的浅色石台上，柔和棚拍光，保留杯身纹理与比例，3:4',
        ),
        tip(
          'A template locks reference slots. Per-image batch is hidden while a template is attached.',
        ),
      ],
    },
    {
      id: 'reference-images',
      title: 'Upload',
      blocks: [
        steps(
          'Add reference, then Add image. You can also drop or paste.',
          'Each file must be under 50 MB. A bad file is marked. Remove unusable images before sending.',
          'Two or more images show Merge references and Per image. Merge is one job. Per image is one job per file.',
        ),
        p('GIF and SVG cannot take a reference. A reference on Image 2.6 disables those formats.'),
        still('zh', 'reference', 'Reference thumbnails above the composer'),
      ],
    },
    {
      id: 'mentions',
      title: '@ mentions',
      blocks: [
        p(
          'Type `@` and pick the thumbnail. The inserted token is bound to that file. Typing the characters @图1 yourself is plain text and does not point at the image. In English the label is @Image 1. Order follows the strip from left to right. After you delete a file, the old token is marked missing.',
        ),
        warn(
          'The fixture in the recording is a mug. If your file is a bottle, say bottle. The model follows the file.',
        ),
      ],
    },
  ],
  related: ['create/batch', 'create/settings', 'create/gpt-image-26'],
}

const settings: GuidePage = {
  id: 'settings',
  title: 'Generation settings',
  summary: 'Ratio, count, quality, format, and the member lock on High and 4K.',
  meta: {
    title: 'Generation settings - Muvloom guide',
    description: 'How Muvloom settings for ratio, count, quality and format work.',
  },
  updated,
  intro: [
    p(
      'Open the settings chip and change values. They apply at once; click outside or press Esc to close. Reset appears next to the title once something changed. It restores Auto and clears the count and quality you just set.',
    ),
    demo('03-generation-settings', 'Two 3:4 serum stills from one prompt', ui),
  ],
  sections: [
    {
      id: 'open-settings',
      title: 'Open generation settings',
      blocks: [
        steps(
          'In Image generation, open Generation settings.',
          'Pick a ratio such as 3:4. Auto lets the model choose the size.',
          'Pick a count. With two images the send button name becomes Generate 2.',
          'Pick Low, Medium or Auto. High is members only.',
          'Click outside to close. The chip should show the ratio and the count.',
        ),
      ],
    },
    {
      id: 'adjust-settings',
      title: 'What each control does',
      blocks: [
        table(
          ['Control', 'Effect', 'Limit'],
          ['Ratio', '3:4, 1:1, 16:9, or custom', 'Do not reuse a custom pixel size for GIF'],
          ['Resolution', '1K, 2K, and 4K for members', 'Non-members stop at 2K'],
          ['Count', 'How many stills', 'Per-image batch ignores this and uses the file count'],
          ['Quality', 'Low, Medium, High, Auto', 'High is locked without a membership'],
          [
            'Format',
            'PNG, JPEG, WebP; Image 2.6 adds GIF and SVG',
            'Compression appears for JPEG and WebP',
          ],
          ['Transparent', 'Local cutout, PNG only', 'Not a model alpha channel'],
          [
            'No rewrite',
            'On by default. The sentence is sent as written',
            'Off lets a gateway rewrite it',
          ],
        ),
        p(
          'No rewrite is on by default. It tells the gateway not to rewrite the prompt. Direct models already use your text. Turn it off only if you want that rewrite. Reset does not update images you already made.',
        ),
      ],
    },
    {
      id: 'models-params',
      title: 'Settings follow the model',
      blocks: [
        p(
          'Changing model hides controls that model does not have. Gemini uses ratio and a 1K/2K/4K tier, not an OpenAI size string. Copying a 2.5 custom size into a 2.6 GIF is rejected. The chip shows the values this model will actually send.',
        ),
      ],
    },
    {
      id: 'agent-settings',
      title: 'Agent settings',
      blocks: [
        p(
          'Agent settings are frame, speed, Confirm before generating, and model. The agent picks the model unless you turn off Auto-select model. With Confirm before generating off it generates without waiting; on means you get a plan first. There is no count stepper. The agent decides the count.',
        ),
        still('zh', 'settings-agent', 'Agent generation settings'),
      ],
    },
  ],
  related: ['create/gpt-image-26', 'account/membership', 'create/models'],
}

const models: GuidePage = {
  id: 'models',
  title: 'Models',
  summary: 'Which image and video models appear, and what to do when a name is missing.',
  meta: {
    title: 'Models - Muvloom guide',
    description: 'Image and video models in Muvloom, and what a missing name means.',
  },
  updated,
  intro: [
    p(
      'The menu is what this account can use right now. A missing name means that deployment has not enabled it. Do not substitute a neighbour and pretend.',
    ),
  ],
  sections: [
    {
      id: 'image-models',
      title: 'Image models',
      blocks: [
        table(
          ['Name', 'Group', 'Use'],
          ['Image 2.5 Flare / Sunburst', 'GPT', 'Stills, reference edits, inpaint masks'],
          ['Image 2.6 Flare / Sunburst', 'GPT', 'Stills, plus GIF and SVG without references'],
          ['Grok Imagine Image 2.0', 'Grok', 'Stills, with that model’s own settings'],
          ['Gemini Flash, Nano Banana, Pro, Flash Lite', 'Banana', 'Ratio plus 1K/2K/4K'],
          ['Agnes Image', 'Agnes', 'Only if it is in the menu'],
        ),
        p(
          'Flare and Sunburst share the Image 2.6 price table. The 2.5 base near 100 credits is not the 2.6 Medium price. Quote from settings or `muvloom images validate`. The CLI id is `gpt-image-2.6-flare` when the label is Image 2.6 Flare.',
        ),
      ],
    },
    {
      id: 'video-models',
      title: 'Video models',
      blocks: [
        p(
          'Video models appear only under Video generation and on canvas video nodes. The usual default is Grok Imagine Video 1.5 Lite. Agnes 2.5 Flash, Seedance 2.0, Veo 3.1 Fast and Veo 3.1 Lite show up only when enabled. The CLI has no video command.',
        ),
      ],
    },
    {
      id: 'missing',
      title: 'A name is missing',
      blocks: [
        list(
          'Refresh. Anonymous visitors can see the public list, but generation requires sign-in.',
          'Image menus do not list video models. Open Video generation.',
          'If Image 2.6 is absent, GIF and SVG are unavailable on this deployment.',
        ),
      ],
    },
  ],
  related: ['create/settings', 'create/gpt-image-26', 'create/video'],
}

const gpt26: GuidePage = {
  id: 'gpt-image-26',
  title: 'GPT Image 2.6',
  summary:
    'Stills, looping GIF and SVG. GIF and SVG cannot take a reference or a custom still size.',
  meta: {
    title: 'GPT Image 2.6 - Muvloom guide',
    description: 'Image 2.6 still prices, GIF frames and sizes, SVG, and the member gate.',
  },
  updated,
  intro: [
    p(
      'Image 2.6 Flare and Sunburst are not silently rerouted to 2.5. If neither name is in the menu, this deployment has not enabled 2.6. They share one price table.',
    ),
  ],
  sections: [
    {
      id: 'still',
      title: 'Stills',
      blocks: [
        p('Keep the format on Image. Credits, Flare and Sunburst alike:'),
        table(
          ['Tier', 'Low', 'Medium', 'High'],
          ['1K', '190', '330', '400'],
          ['2K and 4K', '380', '670', '810'],
        ),
        p(
          'A reference or a mask is an edit. The edit price is the still price times 390/330, rounded to 10, and already includes one reference. Each extra reference adds 60. 4K and High require a membership.',
        ),
      ],
    },
    {
      id: 'gif',
      title: 'GIF',
      blocks: [
        demo(
          '04-gpt26-gif',
          'Image 2.6 Flare GIF submit that the test service failed to finish',
          '2026-11-10 test: settings were 768, 6 frames, GIF. The service returned an error and no file.',
        ),
        steps(
          'Image generation, model Image 2.6 Flare or Sunburst.',
          'In settings choose GIF. Do not keep a custom still size.',
          'Frames are 4, 6, 9, 12 or 16. Default 6. Durations on the page are 0.3, 0.2 and 0.1 seconds. Default 0.2. Sizes are 512 or 768 only.',
          'Remove reference images. GIF is disabled while one is attached.',
          'Close settings, then Generate. A success is a playing multi-frame file, not a still.',
        ),
        table(['Frames', 'Credits'], ['Up to 6', '370'], ['7 to 9', '550'], ['10 to 16', '980']),
        p(
          'Count is forced to 1. The CLI accepts 2–16 frames and 20–2000 ms in steps of 10. The page only offers the safe presets. 768 with 16 frames exceeds the sprite budget and is rejected. On 2026-11-10 the test service accepted a 768×768, 6-frame GIF request for Image 2.6 Flare and then failed with no file. Credits were returned. That recording is the failure, not a finished GIF.',
        ),
      ],
    },
    {
      id: 'svg',
      title: 'SVG',
      blocks: [
        demo(
          '05-gpt26-svg',
          'Image 2.6 Flare SVG submit that the test service failed to finish',
          '2026-11-10 test: format svg, service error, no vector file.',
        ),
        steps(
          'Same model. In settings choose SVG; it applies at once.',
          'Ask for flat shapes, few colors, a clean background. No reference image.',
          'Count is 1. The price is 610 credits.',
        ),
        p(
          'The same test run failed the SVG the same way: the card recorded format svg and Image 2.6 Flare, then “service error, not completed”. Do not substitute a 2.5 PNG and call it a vector.',
        ),
      ],
    },
    {
      id: 'limits',
      title: 'Boundaries',
      blocks: [
        list(
          '2.6 is still Image generation. You only change the model.',
          'Inpaint masks use a GPT image model that supports masks. GIF and SVG are not mask targets.',
          'Non-members see the 2K ceiling and the High-quality lock. The CLI returns PLAN_REQUIRED, exit 4, for `--image-size 4K` and for `--quality high`. The size flag is 1K, 2K, or 4K, not a pixel string.',
        ),
      ],
    },
  ],
  related: ['create/settings', 'account/credits', 'plugins/cli'],
}

const batch: GuidePage = {
  id: 'batch',
  title: 'Batch generation',
  summary:
    'Run one sentence across up to 50 source images, with optional shared references attached to every job.',
  meta: {
    title: 'Batch generation - Muvloom guide',
    description:
      'Image generation versus Batch mode with dual zones (Source images and Shared refs) in Muvloom.',
  },
  updated,
  intro: [
    p(
      'Switch the bottom-left creation mode to Batch to split the reference area into two zones: Source images on the left (up to 50 files, each runs its own job) and optional Shared refs on the right (attached to every job alongside the current source image).',
    ),
    demo('06-batch-each', 'Two mug photos, each placed on white', ui),
  ],
  sections: [
    {
      id: 'batch-how-it-works',
      title: 'Two modes',
      blocks: [
        table(
          ['Mode', 'Result', 'Prompt'],
          [
            'Image generation',
            'One generation sees every reference together',
            'Describe how the files relate',
          ],
          [
            'Batch',
            'One new still per source image (with all shared refs attached)',
            'Use @Current for the active source file and @Ref 1 for shared refs',
          ],
        ),
      ],
    },
    {
      id: 'batch-reference-choice',
      title: 'Which to pick',
      blocks: [
        list(
          'Same product, new background, keep each original: switch to Batch and add files to Source images.',
          'Swap the hero product across many posters: add posters to Source images and the product photo to Shared refs, then cite @Current and @Ref 1.',
          'Combine two pictures into one frame: stay in Image generation and name each role.',
          'Over the single-request reference limit in Image generation: click Switch to Batch to continue.',
        ),
      ],
    },
    {
      id: 'batch-start',
      title: 'Run Batch mode',
      blocks: [
        steps(
          'Pick Batch from the bottom-left mode selector, with a model that accepts references (such as Image 2.5 Flare).',
          'Add files (or a folder) to Source images on the left, and optional fixed references to Shared refs on the right. Drag thumbnails between zones anytime.',
          'Write the prompt using @Current and @Ref 1. Clicking @ on a source thumbnail moves it into Shared refs automatically.',
          'Open Examples in the toolbar to insert a sample prompt or inspect the live task breakdown.',
          'Press send. My work shows one batch card—open it to inspect or download each result.',
        ),
      ],
    },
    {
      id: 'batch-before-submit',
      title: 'Before you send',
      blocks: [
        p(
          'Check the parameter summary and the live breakdown in Examples to verify total tasks (source images × prompt slot combinations) and that 1 + shared refs stays within the model limit. Remove any oversized or unreadable files before sending. Credits are quoted as unit price × total tasks.',
        ),
      ],
    },
    {
      id: 'batch-view-results',
      title: 'Read the card',
      blocks: [
        p(
          'The card shows done, running and queued. A failed file stays on the card as its own row. Successful files can still be downloaded. Deleting one row deletes that record only.',
        ),
      ],
    },
    {
      id: 'batch-write-prompt',
      title: 'The per-image sentence',
      blocks: [
        prompt(
          'White background',
          '保留当前图片中商品的外形、颜色、材质和标识，将背景替换为纯白色。商品居中、完整可见，添加自然接触阴影，不添加文字或其他物体。',
        ),
      ],
    },
    {
      id: 'batch-count-and-cost',
      title: 'Count and credits',
      blocks: [
        p(
          'Each file is its own job at the full unit price. GIF and SVG cannot batch, and they cannot take references.',
        ),
        tip('Prove the sentence on one file, then add the rest.'),
      ],
    },
  ],
  related: ['create/composer', 'create/settings', 'account/credits'],
}

const agent: GuidePage = {
  id: 'agent',
  title: 'Agent and plans',
  summary:
    'When the request is still vague, the agent writes prompts and can show a plan before spending on stills.',
  meta: {
    title: 'Agent and plans - Muvloom guide',
    description: 'Muvloom agent chat, direct generation, and generation plans.',
  },
  updated,
  intro: [
    p(
      'Agent is a chat that can call image tools. Your sentence stays in the thread. The model prompt is a later step.',
    ),
    demo(
      '07-agent-chat',
      'The agent drafts a two-cover plan for a fictional perfume',
      'The recording stops on the plan. Confirm was not pressed.',
    ),
  ],
  sections: [
    {
      id: 'agent-chat',
      title: 'Start a thread',
      blocks: [
        steps(
          'Choose Agent. The type should read Agent mode.',
          'Settings: frame, speed, Confirm before generating, and model. Leave them if you are unsure; the agent picks the model.',
          'State the goal and the count. Say not to use a real brand if the product is fictional.',
          'Press Generate or Start creating, whichever the button shows.',
          'If a plan appears, open a row. With Confirm before generating on, nothing is generated until you confirm.',
        ),
        prompt('Example', '为这款虚构的柑橘香水做 2 张小红书封面，风格清爽，不要出现真实品牌名'),
      ],
    },
    {
      id: 'agent-options',
      title: 'What it will not do',
      blocks: [
        list(
          'It can change model and frame, and it can read references you attached before sending.',
          'It does not set GIF frame counts. Use Image generation and Image 2.6 for that.',
          'Canvas masks are sent from the image toolbar, not from this home chat.',
          'Skills open with `/`. The catalogue is the skills page.',
        ),
      ],
    },
    {
      id: 'agent-drafts',
      title: 'Plans',
      blocks: [
        p(
          'Each row is one future still: prompt, model, frame. Editing one row does not rewrite the others. If the total is over the balance, clear rows instead of pressing generate on all of them.',
        ),
        warn('Not enough credits stops the plan. It does not start the unchecked rows.'),
      ],
    },
    {
      id: 'agent-skills',
      title: 'When to name a skill',
      blocks: [
        p(
          'A skill is instructions for the agent: a poster should lock copy first, a main image should not invent labels. Naming it with `/` is more reliable than hoping it loads the skill. A skill does not add a model and does not turn 2.5 into 2.6.',
        ),
      ],
    },
  ],
  related: ['create/skills', 'create/modes', 'canvas/basics'],
}

const skills: GuidePage = {
  id: 'skills',
  title: 'Skills',
  summary: 'The image, video and shared skills the agent can load, and what each one refuses.',
  meta: {
    title: 'Skills - Muvloom guide',
    description: 'Muvloom agent skills for posters, product images, storyboards and video.',
  },
  updated,
  intro: [
    p(
      'Skills live on the server under `skills/`. The Chinese title in the menu is the first heading of each file. If a deployment removes a skill, it disappears from the menu.',
    ),
  ],
  sections: [
    {
      id: 'how',
      title: 'How to call one',
      blocks: [
        steps(
          'In an agent or canvas chat, type `/`.',
          'Pick a skill, then add the product or the constraint.',
          'Send. “Reading skill” means the body was opened. It does not mean an image exists yet.',
        ),
      ],
    },
    {
      id: 'image-skills',
      title: 'Image',
      blocks: [
        table(
          ['Skill', 'For'],
          ['Poster', 'A poster or banner with a title. Not a marketplace main image'],
          ['Product main image', 'A marketplace hero, subject obvious'],
          ['Product image set', 'A detail-page set, not one hero'],
          ['Restyle / scene swap', 'Keep the product, change the finish or the place'],
          ['Localize', 'Change the language of text on an image'],
          ['Reverse prompt', 'Write a prompt from a finished image. It does not draw another'],
          [
            'Character sheet / storyboard / multi-camera',
            'Turnaround, a sequence, or a contact sheet',
          ],
          ['Art direction', 'Turn one sentence into a brief'],
          ['Create asset / create look', 'Save a reusable file or template'],
          [
            'Four named looks',
            'Rock marble, concrete round window, sea-view hotel, amber. Fixed scenes, not generic filters',
          ],
        ),
      ],
    },
    {
      id: 'video-skills',
      title: 'Video and shared',
      blocks: [
        table(
          ['Skill', 'For'],
          ['Image to video', 'Move an existing still'],
          ['Product main video / seeding / brand film / storyboard short', 'Those video jobs'],
          ['Video production / script briefs', 'Shared constraints, or a script before any shot'],
        ),
        note(
          'A skill may only name tools that exist. It cannot promise a CLI video command or a GIF when GIF is off.',
        ),
      ],
    },
  ],
  related: ['create/agent', 'create/video', 'assets/library'],
}

const videoPage: GuidePage = {
  id: 'video',
  title: 'Video',
  summary: 'How a video job is submitted, and a 5 second clip that played on the canvas.',
  meta: {
    title: 'Video - Muvloom guide',
    description: 'Muvloom video duration, ratio, resolution and first frame.',
  },
  updated,
  intro: [
    note(
      'On 2026-11-10 a Grok Imagine Video 1.5 Lite job completed. Home page: Video generation, 5 seconds, 16:9, 720p, prompt「冰块在玻璃杯里轻轻晃动，镜头缓慢推近」. The agent did not return a video. A canvas node set to 文生视频, then Generate, became a 1280×720 clip. Play advanced to 0:05. Queue request id `8bd27a1b-7e18-47ee-8a3f-42813b66288e`.',
    ),
  ],
  sections: [
    {
      id: 'video-start',
      title: 'Submit',
      blocks: [
        steps(
          'Choose Video generation.',
          'Keep the default model if it is Grok Imagine Video 1.5 Lite. If it is missing, use the first available video model and remember the name on the card.',
          'Duration 5 seconds, ratio 16:9, resolution 720p. 1080p is billed at 1.6× on Lite.',
          'Describe motion, not only a still object.',
          'Generate or Start creating. The URL becomes a canvas project.',
        ),
        still('zh', 'video-entry', 'Video generation entry'),
      ],
    },
    {
      id: 'video-settings',
      title: 'Duration, ratio, resolution',
      blocks: [
        p(
          'Lite ratios are 16:9, 9:16 and 1:1. Resolutions are 480p, 720p and 1080p. Some durations are disabled at some resolutions. Lite accepts a first frame and does not interpolate a last frame.',
        ),
        still('zh', 'video-settings', 'Video duration, ratio and resolution'),
        warn(
          'The CLI has no video command. `images create` will not return an mp4 because the prompt mentions a camera move.',
        ),
      ],
    },
    {
      id: 'video-canvas',
      title: 'Wait on the canvas',
      blocks: [
        demo(
          '08-video',
          'After text-to-video finishes, the canvas plays ice moving in a glass',
          '2026-11-10 test recording. Grok Imagine Video 1.5 Lite, 5 seconds, 720p, played.',
        ),
        p(
          'A queued or running node means the job was accepted. Leaving the page does not cancel it. A failure is written on the node and the charge is returned. Extend and Edit video appear only on models that support them.',
        ),
      ],
    },
  ],
  related: ['canvas/basics', 'create/models', 'account/credits'],
}

const canvasBasics: GuidePage = {
  id: 'basics',
  title: 'Canvas basics',
  summary: 'Open a canvas, move around it, annotate, and export.',
  meta: {
    title: 'Canvas basics - Muvloom guide',
    description: 'Muvloom canvas projects, shortcuts, annotation and export.',
  },
  updated,
  intro: [
    p(
      'A canvas is a pannable project. New results sit beside the source. A My work card does not appear here until you place it, or you start from Canvas.',
    ),
  ],
  sections: [
    {
      id: 'canvas-projects',
      title: 'Open a project',
      blocks: [
        list(
          'Choose Canvas, write the request, press Start creating. The URL becomes `/p/…`.',
          '[[+]] under Canvas in the sidebar starts an empty project.',
          'Place on canvas brings an existing still into a project.',
        ),
        p(
          'Projects save on their own. If you are still on `/image`, open the new row in the sidebar. The cards under the composer are not the canvas.',
        ),
        still('zh', 'canvas', 'Canvas with the image toolbar'),
      ],
    },
    {
      id: 'canvas-basics',
      title: 'Shortcuts',
      blocks: [
        table(
          ['Action', 'Key'],
          ['Select / hand', '{{V}} / {{H}}'],
          ['Pen / arrow / text', '{{D}} / {{A}} / {{T}}'],
          ['Undo / redo', '{{⌘}}{{Z}} / {{⌘}}{{⇧}}{{Z}}'],
          ['Temporary pan', 'Hold {{Space}} and drag'],
          ['Zoom', '{{⌘}} and the wheel'],
        ),
        note('On Windows, {{Ctrl}} replaces {{⌘}}.'),
      ],
    },
    {
      id: 'canvas-annotate',
      title: 'Annotation',
      blocks: [
        p(
          'Pen, arrow and text are notes that travel with the image when you talk to the agent. They are not a mask. Inpaint is the mask. The toolbar eraser deletes whole elements, including the picture. Undo that. To remove an object inside the picture, use Erase on the image toolbar.',
        ),
      ],
    },
    {
      id: 'canvas-export',
      title: 'Multi-select and export',
      blocks: [
        list(
          'Shift-click or drag a box. A batch bar appears.',
          'Batch generate runs one sentence on each selected still.',
          'Export downloads one file, or a zip for many.',
        ),
      ],
    },
  ],
  related: ['canvas/inpaint', 'create/video', 'assets/library'],
}

const canvasInpaint: GuidePage = {
  id: 'inpaint',
  title: 'Inpaint',
  summary: 'Mark a region and change only that region.',
  meta: {
    title: 'Inpaint - Muvloom guide',
    description: 'How Muvloom canvas inpaint works, and when the button stays disabled.',
  },
  updated,
  intro: [
    p(
      'Inpaint sends a mask. Edit whole image does not. The model must support masks. GPT Image models do. If the button is disabled, read the tooltip. Do not switch tools and call the result inpaint.',
    ),
  ],
  sections: [
    {
      id: 'inpaint-steps',
      title: 'Select and send',
      blocks: [
        demo(
          '09-inpaint',
          'After a rectangle on the cup body, the glaze turns matte dark green and the handle stays light',
          '2026-11-10 test recording. Local redraw finished.',
        ),
        steps(
          'Have a still on the canvas. Canvas mode can generate the first one, for example a ceramic mug on a wooden table with the handle visible.',
          'Select the still. On the node canvas press Edit image, then Local redraw. The older image toolbar calls the same step Inpaint.',
          'Choose Rectangle and drag it over the area to change. Brush fills an irregular edge.',
          'Write the change.',
          'Press Generate candidate. The new still should keep everything outside the box.',
        ),
        prompt('Example', '把杯身釉色换成雾面墨绿，杯把保持原样'),
        still('zh', 'canvas-inpaint', 'Local redraw rectangle and instruction'),
        note(
          'On 2026-11-10 the uploaded mug could be selected. Edit image, then 局部重绘, a rectangle on the cup body, the instruction「把杯身釉色换成雾面墨绿，杯把保持原样」, then 生成新候选. The body turned dark green and the handle stayed light. Queue request id `e5a96636-d49e-4d1c-8e3f-e2152bb466d2`. A「图片上传中 0/1」chip appeared briefly after the result and then cleared.',
        ),
      ],
    },
    {
      id: 'inpaint-disabled',
      title: 'When it is disabled',
      blocks: [
        table(
          ['Reason', 'What to do'],
          ['Model has no mask', 'Switch to a GPT Image model'],
          ['Image too small', 'Inpaint wants about 0.8 megapixels'],
          ['Aspect over 3:1', 'Crop first'],
          ['Source is gone', 'Place the image again'],
          ['No region yet', 'Draw one. Send stays disabled'],
        ),
      ],
    },
    {
      id: 'inpaint-other',
      title: 'Nearby tools',
      blocks: [
        table(
          ['Tool', 'Effect'],
          ['Edit whole image', 'One sentence, no region'],
          ['Erase', 'Remove an object and fill from around it'],
          ['Cutout', 'Transparent PNG'],
          ['Crop / outpaint', 'Trim or extend'],
          ['Resize', 'Change pixel size'],
        ),
        note('Toolbox crop is local, spends nothing, and does not use a mask.'),
      ],
    },
  ],
  related: ['canvas/basics', 'create/gpt-image-26', 'tools/toolbox'],
}

const remix: GuidePage = {
  id: 'remix',
  title: 'Remix a case',
  summary: 'Explore copies a case prompt, model and settings back into the composer.',
  meta: {
    title: 'Remix a case - Muvloom guide',
    description: 'How Make the same works on Muvloom Explore.',
  },
  updated,
  intro: [
    p(
      'Explore is `/explore`. Hover a card and press Make the same. If the case has a reference, the button says Make the same with the original.',
    ),
    demo('10-explore-remix', 'A case prompt and model land in the composer', ui),
  ],
  sections: [
    {
      id: 'remix-card',
      title: 'From a card',
      blocks: [
        steps(
          'Open Explore. A category such as Product is optional.',
          'Hover. Make the same is on the bottom edge, next to copy and save.',
          'If the composer already has text, confirm Replace and apply. Cancel leaves your text.',
          'You return to `/image` with the case prompt and its recommended model.',
        ),
        still('zh', 'remix-card', 'Make the same on a case card'),
      ],
    },
    {
      id: 'remix-detail',
      title: 'The detail view',
      blocks: [
        p(
          'Opening the card, rather than Make the same, shows the full prompt. Highlighted words are the ones meant to be swapped. Use as reference adds the case image and does not replace the prompt. If the recommended model is not on your account, the composer is left unchanged.',
        ),
      ],
    },
    {
      id: 'remix-apply',
      title: 'Edit, then generate',
      blocks: [
        p(
          'A toast says the example was applied. Change the subject before you generate. Do not ship the case’s brand names. If Explore says there are no matching cases, there is nothing to remix.',
        ),
        still('zh', 'remix-applied', 'Composer after remix'),
      ],
    },
    {
      id: 'remix-compare',
      title: 'Remix versus your own file',
      blocks: [
        p(
          'Remix brings the case’s words and settings. Your product photo is a reference upload and an @ mention. You can remix first, then replace the subject and attach your file.',
        ),
      ],
    },
  ],
  related: ['create/composer', 'start/first-image', 'assets/library'],
}

const library: GuidePage = {
  id: 'library',
  title: 'Assets',
  summary: 'Saved files, prompts and templates are not the same list as My work.',
  meta: {
    title: 'Assets - Muvloom guide',
    description: 'Muvloom assets: files, prompts and templates.',
  },
  updated,
  intro: [
    p(
      'My work is the generation log. Assets are what you chose to keep. A still that only exists in one browser is not an asset until you save it.',
    ),
  ],
  sections: [
    {
      id: 'assets-projects',
      title: 'Three places',
      blocks: [
        table(
          ['Place', 'Holds'],
          ['My work', 'Each generation, available to download or send back as a reference'],
          ['Canvas projects', 'The board for that project, listed in the sidebar'],
          ['Assets', 'Files, prompts and templates reused across projects'],
        ),
      ],
    },
    {
      id: 'assets-materials',
      title: 'Files',
      blocks: [
        steps(
          'Save as asset on a card, or upload in Assets.',
          'Later, Add reference and choose From assets. Opening the file in Assets does not attach it.',
          'The size limit still applies.',
        ),
        still('zh', 'assets', 'The asset library'),
      ],
    },
    {
      id: 'assets-prompts',
      title: 'Prompts',
      blocks: [
        p(
          'A saved prompt is text only. It does not restore the model or the ratio. An @ mention inside it pointed at a previous file. Pick the mention again after the files change. Typed @ text never binds.',
        ),
      ],
    },
    {
      id: 'assets-looks',
      title: 'Templates',
      blocks: [
        p(
          'A template binds slots to a sentence. While it is attached, per-image batch is off and every slot needs a file. The agent skill that saves a template only works when that skill is in the menu.',
        ),
        still('zh', 'assets-looks', 'A template and its slots'),
      ],
    },
  ],
  related: ['create/composer', 'create/batch', 'create/skills'],
}

const toolbox: GuidePage = {
  id: 'toolbox',
  title: 'Toolbox',
  summary:
    'Crop, compress, convert and collage in the browser. Nothing is uploaded and no credits are spent.',
  meta: {
    title: 'Toolbox - Muvloom guide',
    description: 'Local Muvloom tools: crop, compress, convert, collage and slice.',
  },
  updated,
  intro: [
    p(
      'Toolbox is `/tools`. Processing stays in the browser. Canvas crop and cutout call a model. These tools do not.',
    ),
    demo('11-toolbox-crop', 'A local crop to the Xiaohongshu 1242×1660 preset', ui),
  ],
  sections: [
    {
      id: 'tools-overview',
      title: 'Tools',
      blocks: [
        table(
          ['Tool', 'Does'],
          ['Compress', 'Quality or a target size'],
          ['Convert', 'JPG, PNG, WebP, AVIF'],
          ['Crop', 'Ratios and marketplace sizes'],
          ['Rotate', 'Angle, flip horizontal or vertical'],
          ['Collage / stitch / slice', 'Grid, a long image, or a 3×3, 2×2, 1×3 split'],
          ['Resize', 'Scale, optionally converting'],
        ),
        still('zh', 'toolbox', 'Toolbox index'),
      ],
    },
    {
      id: 'tools-crop',
      title: 'Xiaohongshu size',
      blocks: [
        steps(
          'Open Crop at `/tools/crop`.',
          'Add image and pick a local file.',
          'Under Ratio / size choose Xiaohongshu 1242×1660. Other presets include Taobao 800×800, Amazon 2000×2000, Douyin 1080×1920 and a WeChat cover 900×383.',
          'The card should show 1242×1660. Download.',
        ),
        still('zh', 'toolbox-crop', 'The Xiaohongshu crop preset'),
        note(
          'The crop is centered. It does not spend credits. Sending the file back into the composer is what starts a paid generation.',
        ),
      ],
    },
  ],
  related: ['canvas/inpaint', 'create/composer', 'assets/library'],
}

const credits: GuidePage = {
  id: 'credits',
  title: 'Credits',
  summary:
    'When a job is charged, when it is returned, and why Image 2.6 is not priced at the base 100.',
  meta: {
    title: 'Credits - Muvloom guide',
    description: 'Muvloom credit charges, refunds, and Image 2.6 prices.',
  },
  updated,
  intro: [
    p(
      'The number at the top right is the spendable balance. Toolbox spends nothing. Quote a job from the settings chip or from `muvloom images validate`.',
    ),
  ],
  sections: [
    {
      id: 'credits-cost',
      title: 'Prices',
      blocks: [
        p(
          'Many still models show a base near 100 credits per image. That base is what Image 2.5 and 2.6 multipliers start from. Image 2.5 adds only for resolution: Low, Medium and High cost the same, and a masked edit counts as 1K. That is the first table. The credits you pay for 2.6 are the second table. Flare and Sunburst match in both.',
        ),
        table(['2.5 still', 'Credits'], ['1K', '100'], ['2K', '120'], ['4K', '150']),
        table(
          ['2.6 still', 'Low', 'Medium', 'High'],
          ['1K', '190', '330', '400'],
          ['2K and 4K', '380', '670', '810'],
        ),
        table(
          ['Other 2.6', 'Credits'],
          ['GIF, up to 6 frames', '370'],
          ['GIF, 7–9', '550'],
          ['GIF, 10–16', '980'],
          ['SVG', '610'],
          ['Edit, including one reference', 'Still price × 390/330, rounded to 10'],
          ['Each extra reference', '+60'],
        ),
        p(
          'Video is priced per second. Lite 1080p is 1.6×. Agent text spends credits as well, and each still is extra. Per-image batch is not discounted.',
        ),
      ],
    },
    {
      id: 'credits-refund',
      title: 'Failure and cancel',
      blocks: [
        list(
          'A service error or a rejected image returns that job’s credits. There is no half file.',
          'Cancel while queued or running returns the credits. Persisting cannot be cancelled.',
          'A CLI `jobs wait` timeout is not a failure. The job is still running. Do not create another.',
          'The same idempotency key returns the original job and does not charge again.',
        ),
        warn('Pressing Generate twice starts two jobs.'),
      ],
    },
    {
      id: 'credits-types',
      title: 'Where the balance comes from',
      blocks: [
        p(
          'Subscription balance and top-up balance can both be present. The header number is what you can spend. A new account may receive a grant. The amount is an operator setting, so this page does not hard-code it. Invite rewards, when enabled, are separate from that grant.',
        ),
        p(
          `The CLI uses QUOTA_EXCEEDED or INSUFFICIENT_CREDITS, both exit code 5. Do not retry those. Write to ${SUPPORT_CONTACT.email} with the time and the error code, not a password or a token.`,
        ),
      ],
    },
  ],
  related: ['account/membership', 'create/gpt-image-26', 'plugins/cli'],
}

const membership: GuidePage = {
  id: 'membership',
  title: 'Membership and 4K',
  summary: 'Without a membership the ceiling is 2K, and High quality stays locked.',
  meta: {
    title: 'Membership and 4K - Muvloom guide',
    description: 'Which Muvloom sizes and qualities require a membership.',
  },
  updated,
  intro: [
    p(
      'Membership comes from the account. Non-members top out at 2K. High quality is off. Members can select 4K and High. The check is cached for a few minutes.',
    ),
  ],
  sections: [
    {
      id: 'who',
      title: 'What you see',
      blocks: [
        table(
          ['Account', 'Resolution', 'High quality'],
          ['Not a member', '2K maximum', 'Disabled'],
          ['Member', '4K is selectable when the model has that tier', 'Enabled'],
        ),
        p(
          'On Image 2.6, 4K and 2K cost the same. The gate is whether you can select 4K, not a higher price. A model that does not list 4K still will not offer it to a member.',
        ),
      ],
    },
    {
      id: 'cli-plan',
      title: 'CLI',
      blocks: [
        p(
          '`muvloom images validate --prompt "a poster" --image-size 4K` quotes without charging. `--quality high` needs a membership too. Non-members get PLAN_REQUIRED, exit 4. Use 1K or 2K, or low / medium. Do not pass a pixel string such as 3840x2160.',
        ),
        note('None of the recordings use 4K or High quality.'),
      ],
    },
    {
      id: 'not-a-bypass',
      title: 'What does not bypass it',
      blocks: [
        list(
          'A custom width of 3840 is not the 4K tier.',
          'GIF sizes are only 512 and 768.',
          'Toolbox upscaling is not a model 4K file and does not use the membership.',
        ),
      ],
    },
  ],
  related: ['account/credits', 'create/settings', 'plugins/cli'],
}

const plugins: GuidePage = {
  id: 'cli',
  title: 'Plugins and CLI',
  summary:
    'Connect Muvloom to WorkBuddy, Doubao Work, Claude Code, Codex and other agents, or run the muvloom CLI directly in your terminal.',
  meta: {
    title: 'Plugins and CLI: WorkBuddy, Doubao Work, Claude Code & Codex | Muvloom Guide',
    description:
      'Use Muvloom in WorkBuddy, Doubao Work, Claude Code, Codex and your terminal: WorkBuddy video tutorial, client setup, muvloom CLI commands, job waiting and exit codes.',
  },
  updated: '2026-11-22',
  intro: [
    p(
      'The Muvloom plugin pairs the native `muvloom` CLI with official skills for **WorkBuddy**, **Doubao Work**, **Claude Code**, **Codex** and other agent clients on [Plugin integrations](/connect). Generate images with natural language or `/muv` in your agent, or run `muvloom` directly in a terminal—every result syncs to [Assets](/assets) on your Muvloom account.',
    ),
    workbuddyFilm(
      'Complete WorkBuddy and Muvloom tutorial',
      'Video tutorial: send the setup prompt in WorkBuddy, authorize in your browser, generate a coffee poster, and view the same image in both apps. Recorded in Chinese.',
    ),
  ],
  sections: [
    {
      id: 'install',
      title: 'Supported clients and setup methods',
      blocks: [
        p(
          'Open [Plugin integrations](/connect) and pick your client at the top. Every client offers two setup modes: [[Let the Agent install]] gives you a short prompt to paste into the agent so it installs and connects automatically; [[I’ll do it myself]] shows the terminal commands and skill package for manual setup.',
        ),
        table(
          ['Client', 'Let the Agent install', 'Manual skill setup', 'How to invoke in chat'],
          [
            'WorkBuddy',
            'Copy the prompt to WorkBuddy (installs CLI and runs `muvloom skill install --host workbuddy` into `~/.workbuddy/skills/muvloom/`)',
            'Run `muvloom skill install --host workbuddy` (or download `muvloom-workbuddy.zip` on `/connect` and use Add Skill → Upload Skill)',
            'Start a new task, type `/muv` and select `muvloom`',
          ],
          [
            'Doubao Work',
            'Copy the prompt to Doubao Work (follows `/cli/doubao.md` to import the skill in chat)',
            'Download `muvloom-doubao.zip` on `/connect`, then use Plugins · Skills · Partners → Skills → + Add → Upload skill',
            'Start a new work task, type `/muv`, or search `muv` / `幕芽` with `/` or `@`',
          ],
          [
            'Claude Code',
            'Copy the prompt to Claude Code (follows `/cli/setup.md`)',
            'Run `muvloom skill install --host claude-code` (installs to `~/.claude/skills/muvloom`)',
            'Type `/muv` or `/muvloom`',
          ],
          [
            'Codex',
            'Copy the prompt to Codex (follows `/cli/setup.md`)',
            'Run `muvloom skill install --host codex` (installs to `~/.agents/skills/muvloom`)',
            'Type `/` or `/skills` and pick Muvloom, or use `$muvloom`',
          ],
          [
            'Other agents',
            'Switch to [[Other]] and copy the generic setup prompt',
            'Download `/cli/muvloom-skill.zip` (or run `muvloom skill install --host generic --output <dir>` to export the skill folder), then place `muvloom/` into the host skill folder or upload via UI',
            'Type `/muv` or ask the agent to generate with Muvloom',
          ],
        ),
        note(
          '`muvloom skill install --host` accepts `claude-code`, `codex`, `workbuddy` (with optional `--scope user|project`, default `user`) and `generic` (with optional `--output <dir>` to export a generic skill folder). Doubao Work imports its dedicated skill package—do not pass `--host doubao`.',
        ),
      ],
    },
    {
      id: 'skill-login',
      title: 'Step-by-step tutorial: generate your first image in WorkBuddy',
      blocks: [
        p(
          'If this is your first connection, follow the video above and these four steps to go from setup to a finished poster. Authorization and viewing your works in [Assets](/assets) work the same way across Doubao Work, Claude Code and Codex.',
        ),
        steps(
          '**Send the installation prompt**: Open [Plugin integrations](/connect), select [[WorkBuddy]], and click [[Copy prompt]] under [[Let the Agent install]]. Start a new task in WorkBuddy, paste the full prompt and send it. WorkBuddy installs the skill and starts connecting your account.',
          '**Authorize in your browser**: WorkBuddy opens the approval page (`/device`) in your system default browser; if it does not open automatically, click the authorization link in the chat. Sign in to the Muvloom account where you want to keep your images, review the permissions and click [[Authorize]], then return to WorkBuddy.',
          '**Generate the coffee poster**: Start a new WorkBuddy task, type `/muv`, select `muvloom` from the skill menu, and send the prompt below.',
          '**Open the same image in both places**: Open the finished poster directly in the WorkBuddy reply, then open [Assets](/assets) on Muvloom with the same account and find it under [[Works]].',
        ),
        prompt(
          'Coffee poster',
          'Create one vertical coffee poster at 1K. Put an orange-red moka pot and a glass of iced latte against a cream background, with afternoon sunlight coming in from the side. Leave out all text and show me the finished image here.',
        ),
        note(
          'Device codes last 20 minutes and are approved only on `/device` in your browser. Never paste your password, verification code, cookies or tokens into an agent chat. Generation uses credits from the connected Muvloom account.',
        ),
      ],
    },
    {
      id: 'not-npm',
      title: 'Install or update the CLI manually (latest release)',
      blocks: [
        p(
          'To install or update the CLI yourself in a terminal, switch to [[I’ll do it myself]] on [Plugin integrations](/connect) or run the command for your operating system below. `muvloom` is a single native binary for macOS (arm64/x64), Linux (x64/arm64) and Windows (x64). It requires no Node, npm or Python, and there is no `@muvloom/cli` npm package.',
        ),
        p(
          'The command downloads `install.sh` or `install.ps1` from the current site, verifies the published SHA-256 checksum, and installs or upgrades in place to the latest stable release (skipping the download if already up to date, and never downgrading). Never pipe an installer into `sh` or `iex`, and do not pin an older `MUVLOOM_VERSION`. Upgrading in place keeps your existing sign-in.',
        ),
        prompt('macOS / Linux', unixInstall),
        prompt('Windows PowerShell', windowsInstall),
        list(
          `**Install location**: On macOS and Linux the installer replaces an existing writable \`muvloom\` on PATH, or uses \`/usr/local/bin\` if writable without sudo, or falls back to \`~/.local/bin\` (Windows uses \`%LOCALAPPDATA%\\Programs\\muvloom\`). Override with \`MUVLOOM_INSTALL_DIR\`.`,
          `**Update PATH in the current shell**: If \`muvloom\` is not found right after a first install, run \`${SESSION_PATH.unix}\` on macOS/Linux (or \`${SESSION_PATH.windows}\` in PowerShell), or open a new terminal window.`,
          '**Install the skill and sign in**: For Claude Code, Codex or WorkBuddy, run `muvloom skill install --host claude-code` (or `codex` / `workbuddy`), then run `muvloom auth login` to approve in your browser.',
        ),
      ],
    },
    {
      id: 'service',
      title: 'Service URLs and remote headless sign-in',
      blocks: [
        p(
          'Prompts copied from [Plugin integrations](/connect) already carry the current site origin so the agent connects to the matching service automatically. You only need `MUVLOOM_API_URL` when signing in manually from a terminal or switching between production, enterprise and test deployments on the same machine.',
        ),
        table(
          ['Site you opened', 'Matching MUVLOOM_API_URL'],
          ['https://muvloom.online', 'https://api.muvloom.online (default)'],
          ['https://image.nainma.online', 'https://api.muvloom.online'],
          ['https://image-playground.qiliangjia.one', 'https://image-api.qiliangjia.one'],
          ['https://test.muvloom.online', 'https://test-api.muvloom.online'],
        ),
        list(
          '**Switching services**: The saved connection remembers its API URL. If `MUVLOOM_API_URL` disagrees with the saved connection, `muvloom auth status` exits with `0` and reports `state: "service_mismatch"` (inspect the `state` field), whereas other authenticated commands fail with `SERVICE_MISMATCH` (exit 4). Unset the variable to keep the current connection, or run `muvloom auth login --switch-service` when you intend to switch.',
          '**SSH and cloud hosts without a local browser**: On remote servers, containers or cloud agents (such as Doubao Work cloud tasks), set `MUVLOOM_NO_BROWSER=1` and run `muvloom auth login --no-wait`. Open the printed link in your computer’s default browser to click [[Allow]], then run `muvloom auth login --timeout 30` to finish.',
          '**Config and credential store**: Credentials are stored by default in a `0600` `credentials.json` file inside the `0700` config directory (`credential_store: file` in `auth status`) so silent CLI self-updates never trigger OS keychain password prompts. Set `MUVLOOM_CONFIG_DIR` to isolate a directory or `MUVLOOM_CREDENTIALS_STORE=keychain` to explicitly use the system keychain.',
        ),
      ],
    },
    {
      id: 'commands',
      title: 'CLI commands and generation flags',
      blocks: [
        p(
          'Inside an agent chat you can ask for models, aspect ratios or local reference files in plain language and the skill builds the command for you. In a terminal or script, call `muvloom` directly (every subcommand accepts `--json`):',
        ),
        table(
          ['Command', 'Purpose'],
          [
            'muvloom setup [--origin URL] [--host auto|...]',
            'Install the active host skill, authorize in the browser, fetch capabilities and run a zero-cost smoke check in one step',
          ],
          [
            'muvloom auth login [--no-wait] [--timeout SECONDS] [--switch-service]',
            'Start or resume device-code authorization',
          ],
          [
            'muvloom auth status / auth logout',
            'Check connection state, service URL and credits; or revoke this machine',
          ],
          [
            'muvloom capabilities',
            'List available models, resolution tiers, GIF/SVG limits and base prices',
          ],
          [
            'muvloom images validate --prompt TEXT',
            'Validate flags and quote credits without creating a job or charging',
          ],
          [
            'muvloom images create --prompt TEXT',
            'Create a still image, animated GIF or vector SVG job',
          ],
          [
            'muvloom jobs list | get | wait | cancel',
            'List jobs, inspect a job, wait for completion or cancel a queued/running job',
          ],
          ['muvloom artifacts get | download', 'Inspect or download finished output files'],
          ['muvloom media upload | list | get | download', 'Upload or manage reference images'],
          [
            'muvloom skill install | status',
            'Install the skill (`--host auto`, Claude Code, Codex, WorkBuddy, Cursor, etc.), export a generic skill folder (`--host generic`), or check skill status',
          ],
          [
            'muvloom update self | skill | check / version',
            'Self-update the CLI binary, hot-update installed skills, check release status, or print the CLI version (`auth status` also updates silently every 24h)',
          ],
        ),
        p(
          '`images create` and `images validate` share `--prompt` (or `--prompt-file`), `--model`, `--aspect-ratio`, `--image-size` (`1K`, `2K` or `4K`—never a pixel string), `--quality` (`low`, `medium`, `high`), repeatable `--ref <local-file>`, `--max-credits`, and Image 2.6 flags `--output-format gif|svg`, `--frames`, `--frame-duration-ms` and `--frame-size`. `create` also accepts `--wait <seconds>` (defaults to `0`, which returns immediately after submit; pass a positive integer up to `3600` to wait for completion or trigger `--download`), `--download <dir>` and `--idempotency-key`.',
        ),
        prompt(
          'Generate a still image and download to ./out',
          'muvloom images create --prompt "orange-red moka pot and iced latte on a cream background, afternoon side light, editorial poster" --aspect-ratio 3:4 --image-size 1K --wait 300 --download ./out',
        ),
        prompt(
          'Edit with a local reference image (uploaded automatically)',
          'muvloom images create --prompt "keep the product shape and label, replace the background with a pale stone surface and soft contact shadow" --ref ./product.png --aspect-ratio 1:1 --wait 300 --download ./out',
        ),
        prompt(
          'Generate an Image 2.6 looping GIF and quote a 4K still',
          'muvloom images create --model gpt-image-2.6-flare --output-format gif --frames 8 --prompt "an orange cat waving at the camera, looping sticker, white background" --wait 300 --download ./out\nmuvloom images validate --prompt "a poster" --image-size 4K',
        ),
        warn(
          'Each `images create` produces one file—there is no `--n` batch flag and no video subcommand (submit video on the web canvas). Do not pass `--ref`, `--aspect-ratio`, `--image-size` or `--quality` with GIF or SVG. GIF accepts 2–16 frames, but 768 with 16 frames exceeds the sprite budget; check `gif.max_frames_by_size` in `muvloom capabilities`.',
        ),
      ],
    },
    {
      id: 'jobs',
      title: 'Job lifecycle, wait timeouts and syncing across apps',
      blocks: [
        p(
          'Jobs move through `queued` → `running` → `persisting` → `succeeded` (or `failed` / `canceled`). Every completed job syncs to [Assets](/assets) under [[Works]] on the website, and you can review active devices or click [[Revoke connection]] at the bottom of [Plugin integrations](/connect). The CLI downloads output files automatically only when `images create` is called with both a positive `--wait` and `--download <dir>` and the job reaches `succeeded` before the wait expires (`jobs wait` only polls status and does not download files—use `muvloom artifacts download <artifact-id>` afterwards).',
        ),
        list(
          '**A wait timeout is not a failure**: `muvloom jobs wait` defaults to 300 seconds. When the deadline is reached first, `wait_timed_out` is `true` and the exit code stays `0` while the job continues on the server. Run `muvloom jobs wait <job-id>` on the same ID, and once it reaches `succeeded`, save each artifact from `job.artifacts` with `muvloom artifacts download <artifact-id> --output <path>`—**do not run `images create` again**, or you will start and pay for a second job.',
          '**Idempotency**: Repeating `images create` with the same `--idempotency-key` (8–64 characters of letters, digits, `_`, `.`, `:`, `-`) returns the original job without charging twice. When omitted, the CLI generates a fresh random key per invocation and includes it as `idempotency_key` in the output or temporary error details. If a connection drops, query `muvloom jobs list --idempotency-key <KEY>` or pass that key when retrying—never re-run a keyless `images create` blindly.',
          '**Cancel and refund**: `muvloom jobs cancel <job-id>` stops a `queued` or `running` job and refunds its credits. Once a job reaches `persisting`, it returns `JOB_NOT_CANCELLABLE`.',
          '**Existing files**: If the target path already exists during download, the CLI compares the file contents first: if the bytes are identical, it succeeds with `already_present: true` (making interrupted downloads safe to re-run); only when the existing file holds different bytes does it stop with `FILE_EXISTS` (exit 4) instead of overwriting your file.',
        ),
      ],
    },
    {
      id: 'exit-codes',
      title: 'Exit codes and common error codes',
      blocks: [
        p('Scripts and agents can branch on the process exit code and `error.code` in `--json`:'),
        table(
          ['Exit code', 'Meaning', 'What to do'],
          [
            '0',
            'Success (including `jobs wait` timing out while the job continues)',
            'If timed out, wait again on the same job ID',
          ],
          ['1', 'Unexpected internal error', 'Inspect the error output or re-run with `--json`'],
          [
            '2',
            'Invalid command, flags or request validation (`USAGE`, `INVALID_REQUEST`)',
            'Check `--help` or fix the flag combination / local reference file path',
          ],
          [
            '3',
            'Signed out, or sign-in pending, denied or expired',
            'Run `auth status`, then resume or restart `auth login`',
          ],
          [
            '4',
            'Request rejected by server, or job failed / canceled',
            'Fix the request parameters before retrying',
          ],
          [
            '5',
            'Insufficient credits, over `--max-credits`, or daily quota spent',
            'Do not retry; top up, raise the limit or wait for quota reset',
          ],
          [
            '6',
            'Temporary network or service error',
            'Retry read-only commands directly; for `images create`, reuse `idempotency_key` from the output/error details (or run `jobs wait` if `job_id` is already present)',
          ],
          ['7', 'CLI version is too old', 'Re-run the verified installer from `/connect`'],
        ),
        table(
          ['Error code', 'Cause and resolution'],
          [
            'AUTH_REQUIRED / UNAUTHENTICATED',
            'Not signed in or connection revoked (exit 3). Check `muvloom auth status`, then run `muvloom auth login`.',
          ],
          [
            'AUTH_PENDING',
            'Browser approval is still pending (exit 3). Run `muvloom auth login` again to resume waiting without opening a new page.',
          ],
          [
            'AUTH_EXPIRED / AUTH_DENIED',
            '`AUTH_EXPIRED` means the 20-minute code expired—start a new `auth login`. `AUTH_DENIED` means approval was declined—stop retrying (both exit 3).',
          ],
          [
            'SERVICE_MISMATCH',
            '`MUVLOOM_API_URL` does not match the saved connection (`auth status` exits 0 with `state: "service_mismatch"`; other authenticated commands fail with exit 4). Unset the variable or pass `muvloom auth login --switch-service`.',
          ],
          [
            'PLAN_REQUIRED',
            '`--image-size 4K` and `--quality high` require a membership (exit 4). Use `1K` / `2K` and `low` / `medium` quality.',
          ],
          [
            'INSUFFICIENT_CREDITS / QUOTA_EXCEEDED / MAX_CREDITS_EXCEEDED',
            'Not enough credits, daily quota spent, or quote exceeds `--max-credits` (exit 5). Do not retry automatically.',
          ],
          [
            'INVALID_REQUEST',
            'Unsupported flag combination or unreadable / unsupported local reference file (exit 2). Check `muvloom capabilities`.',
          ],
          [
            'MODEL_UNAVAILABLE / REQUEST_TOO_LARGE',
            'Model is not enabled on this service, or reference file exceeds the 50 MB limit (exit 4). Pick an available model or a smaller file.',
          ],
          [
            'RATE_LIMITED / NETWORK_ERROR / TEMPORARILY_UNAVAILABLE',
            'Transient rate limit or network hiccup (exit 6). Retry read-only commands after a short wait; for `images create`, pass `--idempotency-key` from the error details (or `jobs wait` if `job_id` was returned).',
          ],
          [
            'UNSUPPORTED_VERSION',
            'The CLI is older than the server requirement (exit 7). Upgrade in place with the installer above.',
          ],
        ),
      ],
    },
    {
      id: 'plugin-faq',
      title: 'Troubleshooting FAQ',
      blocks: [
        faq(
          {
            q: 'I installed the skill, but typing /muv does not show Muvloom.',
            a: 'Start a new task and type /muv (in Doubao Work you can also type / or @ and search muv or 幕芽). If muvloom still does not appear, completely quit and reopen the client (WorkBuddy, Doubao Work, Claude Code or Codex) and try again in a new task. Do not invent an unregistered slash command.',
          },
          {
            q: 'The agent generated an image, but I cannot find it on the Muvloom website.',
            a: 'First confirm the job reached succeeded in the agent (if it is still queued or running, ask the agent to check the job status). Then verify that you are signed into the website with the same account you authorized on /device, and refresh the Works tab in Assets.',
          },
          {
            q: 'Can I install the CLI with npm install or npx?',
            a: 'No. There is no official @muvloom/cli npm package. Always use the checksum-verified installer from /connect or this page to install the native binary.',
          },
          {
            q: 'The browser did not open, or I am on a remote SSH / cloud session.',
            a: 'Open the full verification link printed in the chat in your system default browser and click Authorize. On headless SSH or cloud hosts, run MUVLOOM_NO_BROWSER=1 muvloom auth login --no-wait to print the link, approve it in your browser, then run muvloom auth login --timeout 30.',
          },
          {
            q: 'How do I revoke a device connection or uninstall the CLI?',
            a: 'Run muvloom auth logout in your terminal, or open Plugin integrations on the website and click Revoke connection under Connected plugins. To uninstall completely, sign out, delete the muvloom binary from the install directory, remove the PATH line added to your shell profile, and optionally remove the config directory.',
          },
        ),
        p(
          `The raw setup instructions read by agents live at \`/cli/setup.md\`, \`/cli/workbuddy.md\` and \`/cli/doubao.md\`. If you need help, send the output of \`muvloom version\`, the error code and the approximate time to [${SUPPORT_CONTACT.email}](${SUPPORT_MAILTO})—never include a password or token.`,
        ),
      ],
    },
  ],
  related: ['create/gpt-image-26', 'account/credits', 'account/membership'],
}

const faqPage: GuidePage = {
  id: 'faq',
  title: 'FAQ',
  summary: 'Sign-in, credits, GIF, membership and the CLI.',
  meta: {
    title: 'FAQ - Muvloom guide',
    description: 'Common Muvloom failures for sign-in, generation, GIF, membership and the CLI.',
  },
  updated,
  intro: [p('Read the error, then use one of these. Do not hammer Generate.')],
  sections: [
    {
      id: 'faq',
      title: 'Questions',
      blocks: [
        faq(
          {
            q: 'Generate opened a sign-in dialog and nothing started.',
            a: 'Generation requires an account. After you return to the same page, press Generate again. Closing the dialog does not send the job.',
          },
          {
            q: 'Not enough credits, or the daily quota is spent.',
            a: 'The job did not start. Add credits, wait for the reset, or lower the count and resolution. Do not keep pressing Generate.',
          },
          {
            q: 'The card says the service failed.',
            a: 'There is no file. The charge is returned. Retry later with the same settings. Do not swap in Image 2.5 and call a still a GIF.',
          },
          {
            q: 'GIF is disabled.',
            a: 'The model must be Image 2.6 and there must be no reference image. If 2.6 is not in the menu, this deployment has not enabled it.',
          },
          {
            q: 'I picked Medium and the card says low.',
            a: 'Use the settings chip and the ledger. Open the job detail for model, format and size. Do not decide from that one word.',
          },
          {
            q: '4K or High cannot be selected.',
            a: 'Non-members stop at 2K. High is members only. The CLI returns PLAN_REQUIRED.',
          },
          {
            q: 'Inpaint is disabled.',
            a: 'Read the tooltip: unsupported model, image too small, or aspect over 3:1. Switch to a GPT Image model or another file. Edit whole image is not a substitute.',
          },
          {
            q: 'Explore has no cases.',
            a: 'The page says there are no matching cases. Change the category or clear filters.',
          },
          {
            q: 'The CLI says SERVICE_MISMATCH.',
            a: 'MUVLOOM_API_URL does not match the saved connection. Clear it, or pass --switch-service if you intend to change service.',
          },
          {
            q: 'jobs wait timed out.',
            a: 'The job is still running. Wait on the same id. Do not create another.',
          },
        ),
      ],
    },
    {
      id: 'contact',
      title: 'Contact',
      blocks: [
        p(
          'Include a screenshot, the approximate time and the error code. Do not include a password, a verification code or a token.',
        ),
        list(`Email: [${SUPPORT_CONTACT.email}](${SUPPORT_MAILTO})`),
      ],
    },
  ],
  related: ['start/overview', 'account/credits', 'plugins/cli'],
}

export const guideEn: GuideContent = {
  lang: 'en',
  root: GUIDE_PATHS.en,
  meta: {
    title: 'Muvloom guide: images, video, canvas and the agent',
    description:
      'Official Muvloom guide: image generation, references, GPT Image 2.6, batch, agent, video, canvas, remix, toolbox, credits and the CLI.',
    ogImageAlt: 'Muvloom guide',
  },
  chrome: {
    brand: 'Muvloom',
    title: 'Guide',
    lead: 'One task a page, with recordings from the test environment. The picture is the Chinese interface.',
    toc: 'Contents',
    onThisPage: 'On this page',
    prev: 'Previous',
    next: 'Next',
    related: 'Related',
    search: 'Search',
    searchEmpty: 'No matches',
    tipLabel: 'Tip',
    noteLabel: 'Note',
    warnLabel: 'Note',
    updated: 'Updated',
    readingTime: 'About {n} min',
    movedTitle: 'This page has moved',
    movedBody: 'Opening the new page:',
  },
  home: [
    promoFilm(
      'Muvloom film',
      'Chinese labels. Four glazes from one request, a local edit and a close-up.',
    ),
  ],
  groups: [
    { id: 'start', title: 'Start', pages: [overview, firstImage] },
    {
      id: 'create',
      title: 'Create',
      pages: [modes, composer, settings, models, gpt26, batch, agent, skills, videoPage],
    },
    { id: 'canvas', title: 'Canvas', pages: [canvasBasics, canvasInpaint] },
    { id: 'explore', title: 'Explore', pages: [remix] },
    { id: 'assets', title: 'Assets', pages: [library] },
    { id: 'tools', title: 'Tools', pages: [toolbox] },
    { id: 'account', title: 'Account', pages: [credits, membership] },
    { id: 'plugins', title: 'Plugin', pages: [plugins] },
    { id: 'help', title: 'Help', pages: [faqPage] },
  ],
  moved: {
    '': { to: '', anchors: { faq: 'help/faq/#faq' } },
    'getting-started/': {
      to: 'start/overview/',
      anchors: { 'keep-editing': 'start/overview/#view-results', faq: 'help/faq/#faq' },
    },
    'create/': {
      to: 'create/composer/',
      anchors: {
        slots: 'create/composer/#prompts',
        'models-params': 'create/settings/#models-params',
        size: 'create/settings/#adjust-settings',
        'mask-edit': 'canvas/inpaint/#inpaint-steps',
        'saved-prompts': 'assets/library/#assets-prompts',
        'my-works': 'start/overview/#view-results',
        faq: 'help/faq/#faq',
      },
    },
    'canvas/': { to: 'canvas/basics/', anchors: { faq: 'help/faq/#faq' } },
    'agent/': {
      to: 'create/agent/',
      anchors: { 'agent-tips': 'create/agent/#agent-chat', faq: 'help/faq/#faq' },
    },
    'assets/': { to: 'assets/library/', anchors: { faq: 'help/faq/#faq' } },
  },
}
