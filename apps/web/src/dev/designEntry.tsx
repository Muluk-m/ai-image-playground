import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapLocale } from '../i18n'
import '../index.css'
import { initTheme } from '../theme'
import DesignGallery from './DesignGallery'

// 设计系统陈列页的入口（/design.html），只在开发服务器上存在。
initTheme()
void bootstrapLocale().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <DesignGallery />
    </StrictMode>,
  ),
)
