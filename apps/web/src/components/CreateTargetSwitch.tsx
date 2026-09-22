import { useTranslation } from '../i18n'
import { useStore } from '../store'
import { SparkleIcon } from './icons'

/** 首屏输入框上方的两档：生成（直接出图）/ 画布（新建画布项目并把这句话发给智能体）。 */
export default function CreateTargetSwitch() {
  const { t } = useTranslation('shell')
  const target = useStore((s) => s.createTarget)
  const setTarget = useStore((s) => s.setCreateTarget)
  const options = [
    {
      id: 'generate',
      label: t('createTarget.generate'),
      icon: <SparkleIcon className="h-4 w-4" />,
    },
    {
      id: 'canvas',
      label: t('createTarget.canvas'),
      icon: (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6.5 6.5v3l2.8-1.5z" fill="currentColor" />
        </svg>
      ),
    },
  ] as const
  return (
    <div
      role="tablist"
      aria-label={t('createTarget.aria')}
      className="studio-create-target mx-auto flex w-fit rounded-full border border-border bg-card/70 p-1 backdrop-blur"
    >
      {options.map((one) => {
        const active = one.id === target
        return (
          <button
            key={one.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setTarget(one.id)}
            className={`inline-flex h-9 min-w-[7.5rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors ${
              active ? 'studio-generate-button' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {one.icon}
            {one.label}
          </button>
        )
      })}
    </div>
  )
}
