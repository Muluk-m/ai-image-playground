import { ASSET_KINDS, LOOK_PURPOSES } from '@image-playground/shared'
import { useRef, useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import {
  acceptImageFiles,
  collectDroppedFiles,
  filesFromFolderInput,
} from '../../../lib/imageFiles'
import { useStore } from '../../../store'
import type { AssetKind, LookPurpose } from '../types'

const NAME_MAX = 20

const CHOICE_ON = 'border-primary bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary'
const CHOICE_OFF = 'border-border text-muted-foreground hover:bg-muted hover:text-muted-foreground'

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
      onSave: (input: {
        files: File[]
        name: string
        kind: AssetKind
        description: string
      }) => Promise<void>
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

/** 新建素材 / 新建模板同一张表：图 + 名称 + 一个分类 + 描述。 */
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
  const canSave = name.trim().length > 0 && (isAsset || files.length > 0) && !saving

  /**
   * 文件夹里解出来的图一并收下；名字还空着就用文件夹名。模板只要一张图，不收文件夹。
   * 一次进太多先问一声：按真正会收下的张数问，模板永远只收一张，所以不会被打断。
   */
  const addFiles = (incoming: readonly File[], folder: string | null = null) => {
    const images = acceptImageFiles(incoming)
    if (images.length === 0) return
    const accepted = isAsset ? images : images.slice(0, 1)
    confirmImageBatch(accepted.length, () => {
      setFiles((current) => (isAsset ? [...current, ...accepted] : accepted))
      if (isAsset && folder) setName((current) => current || folder.slice(0, NAME_MAX))
    })
  }

  const submit = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      if (props.kind === 'asset') {
        await props.onSave({
          files,
          name: name.trim(),
          kind: assetKind,
          description: description.trim(),
        })
      } else {
        await props.onSave({ files, name: name.trim(), purpose, description: description.trim() })
      }
      props.onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Overlay onClose={props.onClose} tier="raised" label={t(`${ns}.title`)}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="relative z-10 max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-border bg-card p-6 shadow-dialog ring-1 ring-hairline animate-modal-in"
      >
        <div className="mb-5 flex items-center gap-2">
          <h3 className="text-xl font-semibold text-foreground">{t(`${ns}.title`)}</h3>
          {props.agentReady && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handoffToAgent(command)}
              className="ml-auto"
            >
              <Icon name="generate" />
              {isAsset ? t('asset.createWithAgent') : t('look.createWithAgent')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={props.onClose}
            aria-label={t('common:action.close')}
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon name="close" />
          </Button>
        </div>

        <span className="mb-1.5 block text-body-sm font-medium text-foreground">
          {t(`${ns}.images`)} {!isAsset && <span className="text-destructive">*</span>}
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
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-xs"
                    onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}
                    aria-label={t('common:action.delete')}
                    className="absolute -right-1.5 -top-1.5"
                  >
                    <Icon name="close" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t(`${ns}.dropHint`)}</p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="add" />
              {t(`${ns}.fromLocal`)}
            </Button>
            {isAsset && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => folderInputRef.current?.click()}
              >
                <Icon name="folder" />
                {t('createAsset.fromFolder')}
              </Button>
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
            <span className="mb-1.5 block text-body-sm font-medium text-foreground">
              {t(`${ns}.name`)} <span className="text-destructive">*</span>
            </span>
            <span className="relative block">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                placeholder={t(`${ns}.namePlaceholder`)}
                maxLength={NAME_MAX}
                className="border-border bg-muted/60 pr-14 shadow-none"
              />
              <span className="pointer-events-none absolute right-3 top-3 text-label-sm text-muted-foreground">
                {name.length}/{NAME_MAX}
              </span>
            </span>
          </label>
          <div>
            <span className="mb-1.5 block text-body-sm font-medium text-foreground">
              {isAsset ? t('createAsset.kind') : t('createLook.purpose')}
            </span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup">
              {isAsset
                ? ASSET_KINDS.map((one) => (
                    <Button
                      key={one}
                      type="button"
                      variant="outline"
                      role="radio"
                      aria-checked={assetKind === one}
                      onClick={() => setAssetKind(one)}
                      className={`flex-1 ${assetKind === one ? CHOICE_ON : CHOICE_OFF}`}
                    >
                      {t(`asset.kind.${one}`)}
                    </Button>
                  ))
                : LOOK_PURPOSES.map((one) => (
                    <Button
                      key={one}
                      type="button"
                      variant="outline"
                      role="radio"
                      aria-checked={purpose === one}
                      onClick={() => setPurpose(one)}
                      className={`flex-1 ${purpose === one ? CHOICE_ON : CHOICE_OFF}`}
                    >
                      {t(`look.purpose.${one}`)}
                    </Button>
                  ))}
            </div>
          </div>
        </div>

        {
          <label className="mt-4 block">
            <span className="mb-1.5 block text-body-sm font-medium text-foreground">
              {isAsset ? t('createAsset.description') : t('createLook.description')}
            </span>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                isAsset
                  ? t('createAsset.descriptionPlaceholder')
                  : t('createLook.descriptionPlaceholder')
              }
              maxLength={20000}
              className="resize-none border-border bg-muted/60 shadow-none"
            />
          </label>
        }

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={props.onClose}
            className="text-muted-foreground"
          >
            {t('common:action.cancel')}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {t(`${ns}.save`)}
          </Button>
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
