/**
 * 管理后台暴露给私有 overlay 的宿主面。规则同 `apps/web/src/lib/privateHost.ts`：
 * overlay 只许从这里与 `private-overlay.tsx` 取公开树的东西；改这里 = 改对 overlay 的承诺，先扩后缩。
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
export { ApiError, apiClient } from './api-client'
