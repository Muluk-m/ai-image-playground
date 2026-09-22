// PROTOTYPE：「新建素材 / 新建模板」弹窗。上传区（本地 / 从资产选）+ 名称 + 描述；
// 右上「用智能体创建」把 `/create-asset` 或 `/create-look` 放进创作页输入框，等用户点发送。
import { FolderPlus, Info, Sparkles, Upload, X } from 'lucide-react'
import { useState } from 'react'
import Overlay from '../components/Overlay'
import type { Purpose } from './data'

const FIELD =
  'w-full rounded-xl border border-border bg-muted px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none'
const PICK =
  'inline-flex h-10 items-center gap-1.5 rounded-lg bg-background px-4 text-[13px] hover:bg-muted'

export default function CreateDialogPrototype({
  kind,
  onClose,
  onAgent,
}: {
  kind: 'asset' | 'look'
  onClose: () => void
  onAgent: (command: string) => void
}) {
  const [name, setName] = useState('')
  const [assetKind, setAssetKind] = useState<'产品' | '人物'>('产品')
  const [purpose, setPurpose] = useState<Purpose>('场景图')
  const isAsset = kind === 'asset'
  const command = isAsset ? '/create-asset ' : '/create-look '

  return (
    <Overlay onClose={onClose}>
      <div className="w-[min(94vw,720px)] rounded-2xl border border-border bg-background p-6">
        <div className="mb-5 flex items-center gap-2">
          <h2 className="text-lg font-medium">{isAsset ? '新建素材' : '新建模板'}</h2>
          <Info className="h-4 w-4 text-muted-foreground" />
          <button
            type="button"
            onClick={() => onAgent(command)}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/10 px-3 text-[13px] font-medium text-primary hover:bg-primary/15"
          >
            <Sparkles className="h-4 w-4" /> 用智能体创建
          </button>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <label className="mb-1.5 block text-[13px] font-medium">
          {isAsset ? '参考图' : '参考海报 / 效果图'} <span className="text-destructive">*</span>
        </label>
        <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-muted/50 px-6 py-12 text-center">
          <Upload className="h-10 w-10 text-muted-foreground/60" />
          <p className="text-[13px] text-muted-foreground">
            {isAsset
              ? '上传一张或多张同一主体的图（正面 / 侧面 / 细节），或从资产里选'
              : '贴一张你想模仿的海报或效果图，智能体会反推提示词'}
          </p>
          <div className="flex gap-3">
            <button type="button" className={PICK}>
              <Upload className="h-4 w-4" /> 从本地添加
            </button>
            <button type="button" className={PICK}>
              <FolderPlus className="h-4 w-4" /> 从资产添加
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">
              名称 <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 20))}
                placeholder="请输入名称"
                className={FIELD}
              />
              <span className="absolute right-3 top-2.5 text-[11px] text-muted-foreground">{name.length}/20</span>
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">{isAsset ? '类别' : '用途'}</label>
            <div className="flex gap-1.5">
              {(isAsset ? (['产品', '人物'] as const) : (['主图', '海报', '场景图', '详情图'] as const)).map((one) => {
                const active = isAsset ? assetKind === one : purpose === one
                return (
                  <button
                    key={one}
                    type="button"
                    onClick={() => (isAsset ? setAssetKind(one as '产品' | '人物') : setPurpose(one as Purpose))}
                    className={`h-10 flex-1 rounded-xl border text-[13px] ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
                  >
                    {one}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <label className="mb-1.5 mt-4 block text-[13px] font-medium">描述</label>
        <textarea rows={3} placeholder={isAsset ? '这件商品的要点：材质、颜色、不能变的细节…' : '这个效果想用在哪、要保留什么…'} className={FIELD} />

        <div className="mt-5 flex items-center gap-3">
          <p className="text-[11px] text-muted-foreground">
            {isAsset
              ? '手动保存只存你上传的图；要三视图、透明底交给智能体。'
              : '手动保存只存参考图与描述，没有提示词；反推与试效果交给智能体。'}
          </p>
          <button
            type="button"
            disabled={!name}
            onClick={onClose}
            className="ml-auto h-10 rounded-xl bg-primary px-6 text-[13px] font-medium text-primary-foreground disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </Overlay>
  )
}
