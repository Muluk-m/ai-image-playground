import { useState } from 'react'

const SEPARATORS = /[,，、;；/\s]+/

export function parseTextList(text: string): string[] {
  return text.split(SEPARATORS).filter(Boolean)
}

/** 输入框留着原文，只把提交值切成数组：边打字边切会把分隔符吃掉。 */
export default function ListInput({
  id,
  label,
  value,
  onChange,
  className,
  placeholder,
}: {
  id?: string
  label: string
  value: string[]
  onChange: (next: string[]) => void
  className?: string
  placeholder?: string
}) {
  const [text, setText] = useState(() => value.join('、'))

  return (
    <input
      id={id}
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        setText(event.target.value)
        onChange(parseTextList(event.target.value))
      }}
      className={className}
    />
  )
}
