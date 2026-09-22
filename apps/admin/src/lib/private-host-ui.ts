/**
 * 管理后台暴露给私有 overlay 的 UI 宿主面（shadcn 组件）。规则同 `private-host.ts`：先扩后缩。
 * 与 lib 面分开：这里的每个组件都经 `@/lib/utils` 别名，只在 vite / tsc 下可解析，
 * bun 测试直接 import 会失败——overlay 的面板组件走这里，测试只碰 `private-host.ts`。
 */

export { Button } from '../components/ui/button'
export { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../components/ui/form'
export { Input } from '../components/ui/input'
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
export { Switch } from '../components/ui/switch'
export { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
export { Textarea } from '../components/ui/textarea'
