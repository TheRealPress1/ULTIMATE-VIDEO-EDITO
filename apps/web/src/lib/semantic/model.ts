/** OpenAI CLIP ViT-B/32 (MIT), Xenova ONNX conversion. Immutable revision + SHA-256 for every fetched file.
 * https://huggingface.co/Xenova/clip-vit-base-patch32/tree/d15189d7028b43f1d3e65039190477f6af591c2a
 * https://github.com/openai/CLIP/blob/main/LICENSE */
export const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
export const CLIP_REVISION = 'd15189d7028b43f1d3e65039190477f6af591c2a';
export const CLIP_KEY = `${CLIP_MODEL}@${CLIP_REVISION}:q8:512:v1`;
export const CLIP_DIMENSIONS = 512;
export const CLIP_FILES = [
  {
    "path": "config.json",
    "bytes": 4524,
    "sha256": "493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495"
  },
  {
    "path": "tokenizer.json",
    "bytes": 2224119,
    "sha256": "f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd"
  },
  {
    "path": "tokenizer_config.json",
    "bytes": 775,
    "sha256": "60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967"
  },
  {
    "path": "preprocessor_config.json",
    "bytes": 520,
    "sha256": "6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f"
  },
  {
    "path": "onnx/text_model_quantized.onnx",
    "bytes": 64504507,
    "sha256": "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a"
  },
  {
    "path": "onnx/vision_model_quantized.onnx",
    "bytes": 89117001,
    "sha256": "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299"
  }
] as const;
export const CLIP_BYTES = CLIP_FILES.reduce((sum, file) => sum + file.bytes, 0);
export const clipURL = (path: string) => `https://huggingface.co/${CLIP_MODEL}/resolve/${CLIP_REVISION}/${path}`;
export async function verifyClipFile(path: string, data: ArrayBuffer): Promise<void> {
  const expected = CLIP_FILES.find((file) => file.path === path);
  if (!expected || expected.bytes !== data.byteLength) throw new Error(`Invalid description model file: ${path}`);
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.sha256) throw new Error(`Description model integrity check failed: ${path}. Download it again.`);
}
