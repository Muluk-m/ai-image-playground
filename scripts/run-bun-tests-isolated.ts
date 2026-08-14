const roots = process.argv.slice(2)
if (roots.length === 0) throw new Error('Pass at least one test root')

const testFiles: string[] = []
const glob = new Bun.Glob('**/*.test.{ts,tsx}')
for (const root of roots) {
  for await (const file of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
    testFiles.push(file)
  }
}
testFiles.sort()

if (testFiles.length === 0) throw new Error(`No Bun test files found under: ${roots.join(', ')}`)

for (const testFile of testFiles) {
  const child = Bun.spawn([process.execPath, 'test', testFile], {
    cwd: process.cwd(),
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
