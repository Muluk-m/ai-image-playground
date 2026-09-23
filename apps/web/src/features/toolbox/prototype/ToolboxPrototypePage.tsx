// PROTOTYPE — throwaway（分支 prototype/image-toolbox，不进 main）。
// 问题：「工具箱」这个一级页面该长什么样？三个结构不同的变体挂在真实的 `/tools` 入口上，
// `?variant=A|B|C` 切换，底部浮条或 ← / → 键循环。三个变体共用已导入的图片与参数（state.ts），
// 处理是真的（ops.ts，canvas 原生），所以体积、尺寸、回退角标都是这台浏览器的实测结果。
//
// A 工具目录：先选工具再干活，一次只做一件事（iLoveIMG / 改图宝式）。
// B 批处理流水线：不选工具，一张配方同时改尺寸 + 裁剪 + 转格式 + 压缩，队列一次出（BIRME 式）。
// C 预览检查器：以一张大图为中心，前后对比滑杆 + 可拖的裁剪框，调好再应用到全部（Squoosh 式）。
// D 工具目录 · 精修：结构同 A（一个功能一个入口），重做布局与质感——左侧工具栏、中间舞台、右侧专属设置面板。

import PrototypeSwitcher, { useVariantParam } from '../../../components/PrototypeSwitcher'
import VariantA from './VariantA'
import VariantB from './VariantB'
import VariantC from './VariantC'
import VariantD from './VariantD'

const VARIANTS = [
  { key: 'A', name: '工具目录' },
  { key: 'B', name: '批处理流水线' },
  { key: 'C', name: '预览检查器' },
  { key: 'D', name: '工具目录 · 精修' },
] as const
const KEYS = VARIANTS.map((variant) => variant.key)

export default function ToolboxPrototypePage() {
  const [variant, setVariant] = useVariantParam(KEYS)
  return (
    <>
      {variant === 'A' && <VariantA />}
      {variant === 'B' && <VariantB />}
      {variant === 'C' && <VariantC />}
      {variant === 'D' && <VariantD />}
      <PrototypeSwitcher variants={VARIANTS} current={variant} onChange={setVariant} />
    </>
  )
}
