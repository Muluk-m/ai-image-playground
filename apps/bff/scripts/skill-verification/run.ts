/**
 * 批量跑图：每条技能的 3 组测试输入各跑 N 次（默认 2），产出写到 `.verification-runs/<时间>/`，
 * 最后生成并排对比页。**要花钱，交 macmini2 跑**，不在本机跑批：
 *
 *   rmake -c 'cd apps/bff && bun run scripts/skill-verification/run.ts --skills poster,look-clean-studio'
 *
 * 参数：
 *   --skills a,b     要跑的技能，缺省为所有写了 verification/cases.json 的图片技能
 *   --runs 2         每组跑几次
 *   --cases x,y      只跑这几组（冒烟用）
 *   --mock           不连 BFF，用假 BFF 走一遍流程（产出图就是输入图）
 *
 * 环境变量（`--mock` 时不需要）：
 *   SKILL_VERIFY_BFF_URL      BFF 的 API 地址
 *   SKILL_VERIFY_SESSION      登录会话 cookie（image_playground_session）的值；开计费的部署必填
 *   SKILL_VERIFY_DEVICE_ID    可选，匿名设备 ID
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { caseTurn } from '../../src/lib/skill-verification/cases'
import { createFakeBff } from '../../src/lib/skill-verification/fake-bff'
import type { VerificationRun } from '../../src/lib/skill-verification/record'
import type { ReviewCase } from '../../src/lib/skill-verification/review-page'
import {
  IMAGE_MIME_BY_EXTENSION,
  imageExtension,
  type RunnerOptions,
  runVerificationCase,
} from '../../src/lib/skill-verification/runner'
import { loadSkillSetup, parseArgs, RUNS_ROOT, skillsWithCases } from './common'
import { RUN_MANIFEST, writeReviewPage } from './review'

function list(value: string | true | undefined): string[] | undefined {
  return typeof value === 'string' ? value.split(',').filter(Boolean) : undefined
}

function runnerOptions(mock: boolean): RunnerOptions {
  if (mock)
    return {
      baseUrl: 'https://fake-bff.local',
      deviceId: 'skill-verify-mock',
      fetch: createFakeBff().fetch,
      pollIntervalMs: 0,
    }
  const baseUrl = process.env.SKILL_VERIFY_BFF_URL
  if (!baseUrl) throw new Error('缺 SKILL_VERIFY_BFF_URL；只想走一遍流程就加 --mock')
  return {
    baseUrl,
    deviceId: process.env.SKILL_VERIFY_DEVICE_ID ?? 'skill-verify-runner',
    fetch: (input, init) => fetch(input, init),
    ...(process.env.SKILL_VERIFY_SESSION
      ? { sessionCookie: process.env.SKILL_VERIFY_SESSION }
      : {}),
  }
}

const { flags } = parseArgs(process.argv.slice(2))
const mock = flags.get('mock') === true
const runCount = Number(flags.get('runs') ?? 2)
const onlyCases = list(flags.get('cases'))
const skills = list(flags.get('skills')) ?? skillsWithCases()
if (skills.length === 0) throw new Error('没有可跑的技能：先给技能写 verification/cases.json')
// 先把所有技能的输入校验一遍，任何一条坏了都不开跑。
const setups = skills.map(loadSkillSetup)
const options = runnerOptions(mock)

const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}${mock ? '-mock' : ''}`
const runDir = join(RUNS_ROOT, runId)

for (const setup of setups) {
  const skillDir = join(runDir, setup.skill)
  mkdirSync(join(skillDir, 'inputs'), { recursive: true })
  // 对比页与产出放在同一目录，清单里的路径都相对它。每跑完一次就落盘：中途断了，
  // 已经花钱出的图也还在清单里，对比页照样能打分。
  const cases: ReviewCase[] = []
  const runs: VerificationRun[] = []
  const save = () =>
    writeFileSync(
      join(skillDir, RUN_MANIFEST),
      `${JSON.stringify({ skill: setup.skill, cases, runs }, null, 2)}\n`,
    )
  for (const one of setup.cases.filter((item) => !onlyCases || onlyCases.includes(item.id))) {
    const turn = caseTurn(setup.skill, one)
    const images = turn.images.map((image) => {
      // 公共素材与技能自带的同名文件互不覆盖：前缀换成 `shared-` 留在文件名里。
      const file = image.ref.replace(':', '-')
      const bytes = new Uint8Array(readFileSync(setup.locate(image.ref)))
      writeFileSync(join(skillDir, 'inputs', file), bytes)
      const extension = file.split('.').at(-1)!.toLowerCase()
      return { file, mime: IMAGE_MIME_BY_EXTENSION[extension] ?? 'image/png', bytes }
    })
    cases.push({
      id: one.id,
      text: turn.text,
      inputs: turn.images.map((image, at) => ({
        key: image.key,
        src: `${setup.skill}/inputs/${images[at]!.file}`,
      })),
    })
    for (let index = 1; index <= runCount; index++) {
      const label = `${setup.skill} ${one.id}#${index}`
      console.log(`→ ${label}`)
      try {
        const result = await runVerificationCase(options, {
          skill: setup.skill,
          caseId: one.id,
          run: index,
          turn,
          images,
          ...(setup.model ? { model: setup.model } : {}),
        })
        let output: string | null = null
        if (result.image) {
          output = `${one.id}-${index}.${imageExtension(result.image.mime)}`
          writeFileSync(join(skillDir, output), result.image.bytes)
        }
        runs.push({ ...result.run, output: output && `${setup.skill}/${output}` })
        console.log(
          `  ${output ? `出图 ${output}` : `没出图（${result.run.error}）`} · ${result.run.model}`,
        )
      } catch (error) {
        // 一次失败不拖累整批：记成没出图，对比页与判定都会把它算作不过线。
        const message = error instanceof Error ? error.message : String(error)
        runs.push({
          case: one.id,
          run: index,
          output: null,
          model: setup.model ?? 'unknown',
          date: new Date().toISOString().slice(0, 10),
          error: message,
        })
        console.error(`  失败：${message}`)
      }
      save()
    }
  }
}

console.log(`对比页：${await writeReviewPage(runDir)}`)
