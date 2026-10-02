import {
  VERIFICATION_CRITERIA,
  VERIFICATION_CRITERION_LABELS,
  type VerificationRun,
} from './record'

/**
 * 并排对比页：一份本地静态 HTML，跟跑图产出放在同一个目录里，图片都用相对路径。
 * 每条技能一节：3 组测试输入各一行，左边输入图与那句话，右边两次产出，每张图下三项 1–3 分。
 * 「导出验证记录」把这一节的分数连同跑图信息下载成 `record.json`，同时显示在页面上可复制。
 *
 * 页面上的「当前判定」用的是与回填工具同一个 {@link judgeVerificationRecord}：
 * 生成页面时把 `record.ts` 打包成一段脚本嵌进来，判据不在页面里另写一份。
 */

export interface ReviewCase {
  readonly id: string
  /** 发给智能体的那句话（已换成 `[image N]`）。 */
  readonly text: string
  /** 输入图，相对页面所在目录。 */
  readonly inputs: readonly { readonly key: string; readonly src: string }[]
}

export interface ReviewSkill {
  readonly skill: string
  readonly cases: readonly ReviewCase[]
  /** 跑图结果；`output` 相对页面所在目录，导出时原样写进记录。 */
  readonly runs: readonly VerificationRun[]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 嵌进 `<script>` 的 JSON：`</script>` 与 `<!--` 不能原样出现。 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function scoreInputs(skill: string, run: VerificationRun): string {
  if (run.output === null)
    return `<p class="missing">没出图${run.error ? `：${escapeHtml(run.error)}` : ''}</p>`
  return VERIFICATION_CRITERIA.map((criterion) => {
    const name = `${skill}|${run.case}|${run.run}|${criterion}`
    const options = [1, 2, 3]
      .map(
        (score) =>
          `<label><input type="radio" name="${escapeHtml(name)}" value="${score}"${
            run.scores?.[criterion] === score ? ' checked' : ''
          }>${score}</label>`,
      )
      .join('')
    return `<div class="score"><span>${VERIFICATION_CRITERION_LABELS[criterion]}</span>${options}</div>`
  }).join('')
}

function renderRun(skill: string, run: VerificationRun): string {
  const image =
    run.output === null
      ? '<div class="placeholder">无产出</div>'
      : `<a href="${escapeHtml(run.output)}" target="_blank"><img src="${escapeHtml(run.output)}" alt=""></a>`
  return `<figure class="output">${image}<figcaption>第 ${run.run} 次 · ${escapeHtml(run.model)} · ${escapeHtml(run.date)}</figcaption>${scoreInputs(skill, run)}</figure>`
}

function renderSkill(skill: ReviewSkill): string {
  const rows = skill.cases
    .map((one) => {
      const inputs = one.inputs
        .map(
          (input) =>
            `<figure class="input"><img src="${escapeHtml(input.src)}" alt=""><figcaption>${escapeHtml(input.key)}</figcaption></figure>`,
        )
        .join('')
      const runs = skill.runs
        .filter((run) => run.case === one.id)
        .sort((a, b) => a.run - b.run)
        .map((run) => renderRun(skill.skill, run))
        .join('')
      return `<div class="case"><div class="inputs"><h3>${escapeHtml(one.id)}</h3><p class="prompt">${escapeHtml(one.text)}</p><div class="thumbs">${inputs}</div></div><div class="outputs">${runs}</div></div>`
    })
    .join('')
  return `<section data-skill="${escapeHtml(skill.skill)}"><h2>${escapeHtml(skill.skill)}</h2>${rows}<div class="actions"><button type="button" data-export>导出验证记录</button><span class="verdict" data-verdict></span></div><textarea readonly data-output hidden></textarea></section>`
}

const STYLE = `
body{font:14px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;margin:0 auto;padding:16px;max-width:1400px;color:#1f2328;background:#fff}
h1{font-size:20px}h2{font-size:18px;border-bottom:1px solid #d0d7de;padding-bottom:4px;margin-top:32px}h3{margin:0;font-size:14px}
.case{display:grid;grid-template-columns:260px 1fr;gap:16px;padding:12px 0;border-bottom:1px dashed #d0d7de}
.prompt{color:#57606a;word-break:break-all}.thumbs{display:flex;flex-wrap:wrap;gap:8px}
.input img{width:120px;height:120px;object-fit:contain;background:#f6f8fa;border:1px solid #d0d7de}
.outputs{display:flex;flex-wrap:wrap;gap:16px}.output{margin:0;width:360px}
.output img{width:360px;height:360px;object-fit:contain;background:#f6f8fa;border:1px solid #d0d7de}
.placeholder{width:360px;height:360px;display:grid;place-items:center;background:#f6f8fa;color:#cf222e}
figcaption{font-size:12px;color:#57606a}figure{margin:0}
.score{display:flex;gap:8px;align-items:center}.score span{width:96px}.missing{color:#cf222e}
.actions{display:flex;gap:12px;align-items:center;margin:12px 0}.verdict.pass{color:#1a7f37}.verdict.fail{color:#cf222e}
textarea{width:100%;height:200px;font:12px ui-monospace,monospace}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.input img,.output img,.placeholder{background:#161b22;border-color:#30363d}}
`

/** 页面脚本：按单选框拼出记录，判定交给打包进来的 `judgeVerificationRecord`。 */
const SCRIPT = `
const CRITERIA = ${scriptJson(VERIFICATION_CRITERIA)};
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function collect(section) {
  const skill = section.dataset.skill;
  const runs = DATA[skill].map((run) => {
    const { scores: _old, ...rest } = run;
    if (run.output === null) return rest;
    rest.output = DATA_RUN_ID + "/" + run.output;
    const scores = {};
    for (const criterion of CRITERIA) {
      const picked = section.querySelector('input[name="' + CSS.escape(skill + '|' + run.case + '|' + run.run + '|' + criterion) + '"]:checked');
      if (!picked) return rest;
      scores[criterion] = Number(picked.value);
    }
    return { ...rest, scores };
  });
  return { skill, reviewedAt: today(), runs };
}
function refresh(section) {
  const verdict = judge(collect(section));
  const el = section.querySelector('[data-verdict]');
  el.className = 'verdict ' + (verdict.passed ? 'pass' : 'fail');
  el.textContent = verdict.passed ? '当前判定：过线，平均 ' + verdict.verified.score : '当前判定：未过线 — ' + verdict.reasons.join('；');
}
for (const section of document.querySelectorAll('section[data-skill]')) {
  section.addEventListener('change', () => refresh(section));
  refresh(section);
  section.querySelector('[data-export]').addEventListener('click', () => {
    const text = JSON.stringify(collect(section), null, 2) + '\\n';
    const out = section.querySelector('[data-output]');
    out.hidden = false; out.value = text;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = section.dataset.skill + '.record.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}
`

/**
 * 渲染整页。`judgeScript` 是浏览器里可执行的一段脚本，执行后全局要有
 * `judge(record) => VerificationVerdict`（由生成脚本把 `record.ts` 打包得到）。
 */
export function renderReviewPage(
  runId: string,
  skills: readonly ReviewSkill[],
  judgeScript: string,
): string {
  const data = Object.fromEntries(skills.map((skill) => [skill.skill, skill.runs]))
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>技能效果评分</title>
<style>${STYLE}</style>
</head>
<body>
<h1>技能效果评分</h1>
<p>每张图按三项各打 1–3 分：主体保真（商品 / 人物是否走样）、效果符合描述（是否做成了技能说的那种图）、无明显瑕疵（畸形、乱码文字、穿帮）。6 张主体保真都 ≥ 2 且平均 ≥ 2.5 为过线。打完点「导出验证记录」，把下载的文件存为该技能目录下的 <code>verification/record.json</code>，再运行回填工具。</p>
${skills.map(renderSkill).join('\n')}
<script>${judgeScript.replaceAll('</script', '<\\/script')}</script>
<script>const DATA = ${scriptJson(data)};const DATA_RUN_ID = ${scriptJson(runId)};${SCRIPT}</script>
</body>
</html>
`
}
