// 对比页里的判定脚本入口：只把唯一那份过线判据挂到全局。
import { judgeVerificationRecord } from '../../src/lib/skill-verification/record'

;(globalThis as { judge?: typeof judgeVerificationRecord }).judge = judgeVerificationRecord
