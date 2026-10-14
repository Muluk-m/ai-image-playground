import { realpathSync } from 'node:fs'

// The private BFF is imported by file URL. It must load the same elysia and
// drizzle-orm copies as apps/bff, or `instanceof Elysia` fails and the process
// exits before it listens. A public image has no overlay and skips this.
const publicParent = '/app/apps/bff/src/index.ts'
const privatePackagePath = '/app/private/apps/bff/package.json'
const privateEntryPath = '/app/private/apps/bff/index.ts'

if (!(await Bun.file(privatePackagePath).exists())) {
  console.log('shared bff modules: no private bff package, skipped')
} else {
  const privateParent = (await Bun.file(privateEntryPath).exists())
    ? privateEntryPath
    : privatePackagePath
  const manifest = (await Bun.file(privatePackagePath).json()) as {
    dependencies?: Record<string, string>
  }
  const specifiers = [
    ...new Set(['elysia', 'drizzle-orm', ...Object.keys(manifest.dependencies ?? {})]),
  ]

  let failed = false
  for (const specifier of specifiers) {
    let publicResolved: string
    let privateResolved: string
    try {
      publicResolved = Bun.resolveSync(specifier, publicParent)
    } catch (error) {
      console.error(`public bff cannot resolve ${specifier}: ${String(error)}`)
      failed = true
      continue
    }
    try {
      privateResolved = Bun.resolveSync(specifier, privateParent)
    } catch (error) {
      console.error(
        `private bff cannot resolve ${specifier} from the public bff deploy; add it to apps/bff dependencies: ${String(error)}`,
      )
      failed = true
      continue
    }
    const publicReal = realpathSync(publicResolved)
    const privateReal = realpathSync(privateResolved)
    if (publicReal !== privateReal) {
      console.error(
        `duplicate module ${specifier}\n  public  ${publicReal}\n  private ${privateReal}`,
      )
      failed = true
      continue
    }
    console.log(`${specifier} -> ${publicReal}`)
  }

  if (!failed) {
    const publicElysia = await import(Bun.resolveSync('elysia', publicParent))
    const privateElysia = await import(Bun.resolveSync('elysia', privateParent))
    const plugin = new privateElysia.Elysia()
    if (!(plugin instanceof publicElysia.Elysia)) {
      console.error('instanceof Elysia is false; public and private bff loaded different copies')
      failed = true
    }
  }

  if (failed) process.exit(1)
}
