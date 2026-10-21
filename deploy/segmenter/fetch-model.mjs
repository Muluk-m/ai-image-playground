// Build-time only: downloads the pinned EdgeTAM ONNX files into the image and checks every byte.
// Nothing is fetched at runtime; the container has no route to Hugging Face and needs none.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const REPO = 'onnx-community/EdgeTAM-ONNX'
const REVISION = '9c77c7bff7fd0f3079585fa17af7f730ddc531ed'
const FILES = {
  'config.json': '4778c0fb960ce3f2c05871812ea3aa77788d0d8edb7234b665c7e26e3026d405',
  'preprocessor_config.json': '126d931a4698900d085aae8c2cf57ecc6923fa60b0bf425e490189f14c7200ee',
  'processor_config.json': '01ff3f21ce289307c81cc1cd27110d9f6b566c5cde5dc60bb434e7f8e3bfe4c9',
  'onnx/vision_encoder_fp16.onnx': 'd8f560849085892866a5c652a600cafbbd301e11c15ff0d89c81e15fe91264ac',
  'onnx/vision_encoder_fp16.onnx_data':
    '6a6741eb00b3049939675569818b207953cb13113a80ca9580c9c714d8646b38',
  'onnx/prompt_encoder_mask_decoder_fp16.onnx':
    'f6c0e539017b05ff12cd5be869f2a125d946dee10f6e79b64a7466dfceafafb9',
  'onnx/prompt_encoder_mask_decoder_fp16.onnx_data':
    'bda4d98aef24b7589313f9771c8d2d6380716a256bf5c926326eaf5054097d5b',
}

const target = join(process.argv[2] ?? '/models', 'EdgeTAM-ONNX')
for (const [file, expected] of Object.entries(FILES)) {
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`
  let bytes
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      break
    } catch (error) {
      if (attempt >= 4) throw new Error(`${file}: ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
    }
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`${file}: sha256 ${actual}, expected ${expected}`)
  await mkdir(dirname(join(target, file)), { recursive: true })
  await writeFile(join(target, file), bytes)
  console.log(`${file} ${bytes.length}`)
}
