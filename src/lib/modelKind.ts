import type { ModelInfo } from '../types';

/* ------------------------------------------------------------------ *
 * 「这个 ID 看起来是聊天模型吗」
 *
 * 聚合网关的 /models 经常把整个后端能跑的东西一股脑列出来：Stable Diffusion
 * 的各种 checkpoint、embedding、rerank、语音识别……它们全都打不通
 * /chat/completions，混在模型选择器里纯属噪音。
 *
 * 这里只做**保守的形态判断**，不联网也不猜能力：
 *   - 命中已知的非聊天关键词 → 判为非聊天
 *   - 其余一律当聊天模型
 *
 * 宁可漏判也不误判 —— 把一个能用的聊天模型藏起来，比多留几个噪音更糟。
 * 判断结果只影响「默认显示什么」，关掉开关随时能看到全部。
 * ------------------------------------------------------------------ */

/** 图像生成 / 编辑 */
const IMAGE = [
  'stable-diffusion', 'stablediffusion', 'sdxl', 'sd-xl', 'sd15', 'sd-1.5', 'sd3', 'sd-3',
  'flux', 'dall-e', 'dalle', 'midjourney', 'kandinsky', 'playground-v', 'openjourney',
  'dreamshaper', 'realistic-vision', 'deliberate', 'anything-v', 'anythingv', 'orangemix',
  'abyssorange', 'meinamix', 'counterfeit', 'revanimated', 'majicmix', 'chilloutmix',
  'pony', 'juggernaut', 'epicrealism', 'albedobase', 'analog-diffusion', 'inpainting',
  'img2img', 'txt2img', 'controlnet', 'lora', 'upscal', 'esrgan', 'gfpgan', 'codeformer',
  'remove-background', 'rembg', 'ip-adapter', 'animatediff', 'svd', 'zeroscope',
  'wan2', 'kling', 'hunyuan-video', 'cogvideo', 'seedream', 'seededit', 'imagen',
];

/** 向量 / 排序 */
const EMBEDDING = ['embedding', 'embed-', '-embed', 'bge-', 'gte-', 'm3e-', 'text2vec', 'rerank', 'reranker'];

/** 语音 */
const AUDIO = ['whisper', 'tts', 'text-to-speech', 'speech-to-text', 'asr', 'voice', 'sovits', 'musicgen', 'audiogen', 'suno'];

/** 其他明显不是对话的 */
const OTHER = ['moderation', 'classif', 'ocr-', 'detect', 'segment-anything', 'sam-vit'];

/** 已知只提供图像后端的 owner / 前缀 */
const IMAGE_OWNERS = ['aihorde', 'stability', 'stabilityai', 'comfyui', 'novelai', 'leonardo', 'ideogram', 'recraft'];

const ALL = [...IMAGE, ...EMBEDDING, ...AUDIO, ...OTHER];

/**
 * 返回非聊天的理由；是聊天模型（或判断不出来）时返回 null。
 * 返回理由而不是布尔值，是为了能在界面上说清楚「为什么把它藏了」。
 */
export function nonChatReason(m: ModelInfo): string | null {
  const id = m.id.toLowerCase();
  const owner = (m.ownedBy ?? '').toLowerCase();
  const head = id.split('/')[0];

  if (IMAGE_OWNERS.includes(owner) || IMAGE_OWNERS.includes(head)) return '图像生成后端';

  const hit = ALL.find((k) => id.includes(k));
  if (!hit) return null;

  if (IMAGE.includes(hit)) return '图像模型';
  if (EMBEDDING.includes(hit)) return '向量 / 排序模型';
  if (AUDIO.includes(hit)) return '语音模型';
  return '非对话模型';
}

export function isChatModel(m: ModelInfo): boolean {
  return nonChatReason(m) === null;
}
