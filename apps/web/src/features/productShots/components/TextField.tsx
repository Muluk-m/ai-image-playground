import { FIELD, LABEL } from '../../../components/panelStyles'

interface TextFieldProps {
  label: string
  /** 受控与不受控二选一：会把刚敲下的分隔符解析掉的列表格必须走 `defaultValue`。 */
  value?: string
  defaultValue?: string
  placeholder?: string
  notice?: string
  onChange: (value: string) => void
}

export default function TextField({
  label,
  value,
  defaultValue,
  placeholder,
  notice,
  onChange,
}: TextFieldProps) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input
        type="text"
        aria-label={label}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 ${FIELD}`}
      />
      {notice && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{notice}</p>}
    </label>
  )
}
