export default function DropOverlay({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-400 bg-white/85 text-sm font-medium text-blue-600 dark:border-blue-500/60 dark:bg-gray-900/85 dark:text-blue-300">
      {label}
    </div>
  )
}
