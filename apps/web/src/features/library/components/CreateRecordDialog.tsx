import { ASSET_KINDS, LOOK_PURPOSES } from '@image-playground/shared'
import { useRef, useState } from 'react'
import { CloseIcon, FolderIcon, PlusIcon, SparkleIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import {
  acceptImageFiles,
  collectDroppedFiles,
  filesFromFolderInput,
} from '../../../lib/imageFiles'
import { useStore } from '../../../store'
import type { AssetKind, LookPurpose } from '../types'

const NAME_MAX = 20

const FIELD =
  'w-full rounded-xl border border-border bg-muted/60 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring'
const CHOICE =
  'h-10 flex-1 rounded-xl border text-sm transition focus:outline-none focus:ring-2 focus:ring-ring'

/** 「用智能体创建」：跳到创作页、目标切成画布、命令放进输入框，等用户自己点发送。 */
export function handoffToAgent(command: string): void {
  const store = useStore.getState()
  store.setCreateTarget('canvas')
  store.setPrompt(command)
  store.setAppMode('image')
}

type Props = { agentReady: boolean } & (
  | {
      kind: 'asset'
      onClose: () => void
      onSave: (input: { files: File[]; name: string; kind: AssetKind }) => Promise<void>
    }
  | {
      kind: 'look'
      onClose: () => void
      onSave: (input: {
        files: File[]
        name: string
        purpose: LookPurpose
        description: string
      }) => Promise<void>
    }
)

/** 新建素材 / 新建模板同一张表：图 + 名称 + 一个分类 + 描述（只有模板有）。 */
export default function CreateRecordDialog(props: Props) {
  const { t } = useTranslation(['library', 'common'])
  const [files, setFiles] = useState<File[]>([])
  const [name, setName] = useState('')
  const [assetKind, setAssetKind] = useState<AssetKind>('product')
  const [purpose, setPurpose] = useState<LookPurpose>('scene')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const isAsset = props.kind === 'asset'
  const ns = isAsset ? 'createAsset' : 'createLook'
  const command = isAsset ? '/create-asset ' : '/create-look '
  const previews = useObjectUrls(files)
  const canSave = name.trim().length > 0 && files.length > 0 && !saving

  /** 文件夹里解出来的图一并收下；名字还空着就用文件夹名。模板只要一张图，不收文件夹。 */
  const addFiles = (incoming: readonly File[], folder: string | null = null) => {
    const images = acceptImageFiles(incoming)
    if (images.length === 0) return
    setFiles((current) => (isAsset ? [...current, ...images] : images.slice(0, 1)))
    if (isAsset && folder) setName((current) => current || folder.slice(0, NAME_MAX))
  }

  const submit = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      if (props.kind === 'asset') {
        await props.onSave({ files, name: name.trim(), kind: assetKind })
      } else {
        await props.onSave({ files, name: name.trim(), purpose, description: description.trim() })
      }
      props.onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Overlay onClose={props.onClose} tier="raised">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="relative z-10 w-[min(94vw,680px)] rounded-3xl border border-border bg-card p-6 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10"
      >
        <div className="mb-5 flex items-center gap-2">
          <h3 className="text-lg font-semibold text-foreground">{t(`${ns}.title`)}</h3>
          {props.agentReady && (
            <button
              type="button"
              onClick={() => handoffToAgent(command)}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/10 px-3 text-[13px] font-medium text-primary transition hover:bg-primary/15"
            >
              <SparkleIcon className="h-4 w-4" />
              {isAsset ? t('asset.createWithAgent') : t('look.createWithAgent')}
            </button>
          )}
          <button
            type="button"
            onClick={props.onClose}
            aria-label={t('common:action.close')}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <span className="mb-1.5 block text-[13px] font-medium text-foreground">
          {t(`${ns}.images`)} <span className="text-destructive">*</span>
        </span>
        <div
          onDragEnter={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void collectDroppedFiles(e.dataTransfer).then(({ files: dropped, folder }) =>
              addFiles(dropped, folder),
            )
          }}
          className={`flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-8 text-center transition ${
            dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/40'
          }`}
        >
          {previews.length > 0 ? (
            <ul className="flex flex-wrap justify-center gap-2">
              {previews.map((preview, i) => (
                <li key={preview.key} className="relative">
                  <img
                    src={preview.url}
                    alt=""
                    className="h-20 w-20 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}
                    aria-label={t('common:action.delete')}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-black/70 p-0.5 text-white"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t(`${ns}.dropHint`)}</p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-card px-4 text-[13px] text-foreground transition hover:bg-muted"
            >
              <PlusIcon className="h-4 w-4" />
              {t(`${ns}.fromLocal`)}
            </button>
            {isAsset && (
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-card px-4 text-[13px] text-foreground transition hover:bg-muted"
              >
                <FolderIcon className="h-4 w-4" />
                {t('createAsset.fromFolder')}
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple={isAsset}
            className="hidden"
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          {isAsset && (
            <input
              ref={folderInputRef}
              type="file"
              // React 的类型里没有这个非标准属性，但 Chrome / Edge / Safari / Firefox 都支持。
              {...{ webkitdirectory: '' }}
              multiple
              className="hidden"
              onChange={(e) => {
                const { files: picked, folder } = filesFromFolderInput(e.target.files)
                addFiles(picked, folder)
                e.target.value = ''
              }}
            />
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-foreground">
              {t(`${ns}.name`)} <span className="text-destructive">*</span>
            </span>
            <span className="relative block">
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                placeholder={t(`${ns}.namePlaceholder`)}
                maxLength={NAME_MAX}
                className={FIELD}
              />
              <span className="pointer-events-none absolute right-3 top-3 text-[11px] text-muted-foreground">
                {name.length}/{NAME_MAX}
              </span>
            </span>
          </label>
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-foreground">
              {isAsset ? t('createAsset.kind') : t('createLook.purpose')}
            </span>
            <div className="flex gap-1.5" role="radiogroup">
              {isAsset
                ? ASSET_KINDS.map((one) => (
                    <button
                      key={one}
                      type="button"
                      role="radio"
                      aria-checked={assetKind === one}
                      onClick={() => setAssetKind(one)}
                      className={`${CHOICE} ${assetKind === one ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
                    >
                      {t(`asset.kind.${one}`)}
                    </button>
                  ))
                : LOOK_PURPOSES.map((one) => (
                    <button
                      key={one}
                      type="button"
                      role="radio"
                      aria-checked={purpose === one}
                      onClick={() => setPurpose(one)}
                      className={`${CHOICE} ${purpose === one ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
                    >
                      {t(`look.purpose.${one}`)}
                    </button>
                  ))}
            </div>
          </div>
        </div>

        {!isAsset && (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-[13px] font-medium text-foreground">
              {t('createLook.description')}
            </span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('createLook.descriptionPlaceholder')}
              className={`${FIELD} resize-none`}
            />
          </label>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-xl px-4 py-2 text-sm text-muted-foreground transition hover:bg-muted"
          >
            {t('common:action.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {t(`${ns}.save`)}
          </button>
        </div>
      </form>
    </Overlay>
  )
}

/** 本地文件的预览地址，随文件列表建与撤。 */
function useObjectUrls(files: File[]): Array<{ key: string; url: string }> {
  const ref = useRef<Map<File, string>>(new Map())
  const map = ref.current
  for (const [file, url] of map) {
    if (!files.includes(file)) {
      URL.revokeObjectURL(url)
      map.delete(file)
    }
  }
  return files.map((file) => {
    let url = map.get(file)
    if (!url) {
      url = URL.createObjectURL(file)
      map.set(file, url)
    }
    return { key: url, url }
  })
}
