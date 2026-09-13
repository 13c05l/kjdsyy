// Pairwise vision scoring.
//
// One request per candidate, containing exactly two images: the reference and
// that candidate. The previous implementation packed the reference plus 5-10
// candidates into a single call, which diluted the model's attention across
// images and was a major source of bad rankings.

import { endpointUrl, apiModeFor, modelText, parseJsonObject, buildRequestBody, isFatalStatus } from "./api.js";

export const DIMENSIONS = [
  { key: "productType", label: "产品类型", weight: 0.25 },
  { key: "function", label: "核心功能", weight: 0.25 },
  { key: "shape", label: "外形", weight: 0.20 },
  { key: "structure", label: "结构", weight: 0.15 },
  { key: "material", label: "材质", weight: 0.10 },
  { key: "cost", label: "成本", weight: 0.05 }
];

export const VERDICTS = ["同款", "高仿款", "同功能相似款", "不相关"];

const INSTRUCTION = [
  "你是资深电商选品分析师。任务是判断图 B 与图 A 是同款、同功能相似款，还是不相关商品。",
  "必须先判断产品类型和核心功能，再判断是否为同一外观/结构。不要因为外壳不同就否定同一功能方案，也不要因为都属于同一大类就误判为同款。",
  "同款：主体外观、关键组件布局和功能方案基本一致。",
  "同功能相似款：属于同一细分产品、解决同一使用场景、核心功能和组件方案相近，但外观或结构明显不同。",
  "例如：参考图是三路电动猫追逐玩具，候选也是多路电动猫追逐玩具，即使外壳、轨道布局不同，也应给较高的产品类型和核心功能分，并判为同功能相似款，不应判为不相关。",
  "颜色不同但其余一致，仍算同款。",
  "如果任一图片是网页截图，请忽略浏览器边框、页面文字、水印和按钮，只看核心商品本体。",
  "商品标题和关键词是辅助证据，图片是主要证据；标题不能单独决定同款。",
  "",
  "请分别给出六项 0-100 的评分：",
  "productType 产品类型：是否属于同一细分产品，而不是只看宠物用品这个大类",
  "function 核心功能：电动方式、运动/互动方式、控制方式、组件数量和使用场景是否相近",
  "shape 外形轮廓：整体形状和比例是否接近；同功能不同外壳不应因此判为不相关",
  "structure 结构细节：关键部件、连接方式和布局是否相同；不同设计允许得到中等分",
  "material 材质观感：表面质感、光泽、材料类型是否接近",
  "cost 成本档次：做工精细度和价位区间是否相当",
  "",
  "verdict 只能是以下四种之一：同款 / 高仿款 / 同功能相似款 / 不相关",
  "reason 用中文说明判断依据，不超过 40 字，必须同时指出产品类型/功能和外观结构差异。",
  "",
  '严格返回 JSON 对象，不要任何额外文字：{"productType":数字,"function":数字,"shape":数字,"structure":数字,"material":数字,"cost":数字,"verdict":"同功能相似款","reason":"文字"}'
].join("\n");

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number)) / 100;
}

export function weightedTotal(scores) {
  let total = 0;
  let weightUsed = 0;
  for (const dimension of DIMENSIONS) {
    const value = scores[dimension.key];
    if (!Number.isFinite(value)) continue;
    total += value * dimension.weight;
    weightUsed += dimension.weight;
  }
  return weightUsed ? total / weightUsed : null;
}

export function normalizeVerdict(value) {
  const text = String(value || "").trim();
  if (text === "同类不同款") return "同功能相似款";
  return VERDICTS.includes(text) ? text : "";
}

/** Turn a raw model reply into the shape the UI and export expect. */
export function parseScoreReply(text) {
  const payload = parseJsonObject(text);
  const scores = {};
  for (const dimension of DIMENSIONS) {
    scores[dimension.key] = clampScore(payload[dimension.key]);
  }
  const hasAnyScore = DIMENSIONS.some((dimension) => Number.isFinite(scores[dimension.key]));
  if (!hasAnyScore) throw new Error("模型返回的 JSON 中没有有效评分");
  return {
    scores,
    visionScore: weightedTotal(scores),
    verdict: normalizeVerdict(payload.verdict),
    reason: String(payload.reason || "").slice(0, 60)
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const REQUEST_TIMEOUT_MS = 20000;

/** Score one candidate. Retries transient failures, gives up fast on fatal ones. */
export async function scorePair({ referenceImage, candidateImage, settings, signal, referenceTitle = "", keywords = "", candidateTitle = "", candidateDetails = "", retries = 0 }) {
  const mode = apiModeFor(settings.endpoint, settings.apiMode || "auto");
  const url = endpointUrl(settings.endpoint, settings.apiMode || "auto");
  const body = buildRequestBody({
    mode,
    model: settings.model,
    instruction: INSTRUCTION,
    referenceImage,
    candidateImage,
    referenceTitle,
    keywords,
    candidateTitle,
    candidateDetails
  });

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new DOMException("已停止", "AbortError");
    try {
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
      const abortExternal = () => timeoutController.abort();
      signal?.addEventListener("abort", abortExternal, { once: true });
      let response;
      let raw;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify(body),
          signal: timeoutController.signal
        });
        raw = await response.text();
      } catch (error) {
        if (signal?.aborted) throw new DOMException("已停止", "AbortError");
        if (timeoutController.signal.aborted) {
          const timeoutError = new Error(`接口请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）。可能是接口排队、限流或请求图片过大`);
          timeoutError.code = "TIMEOUT";
          timeoutError.retryable = true;
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortExternal);
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = {}; }

      if (!response.ok) {
        const detail = payload.error?.message || raw.slice(0, 200) || `HTTP ${response.status}`;
        const error = new Error(`接口失败 ${response.status}：${detail}`);
        error.status = response.status;
        error.fatal = isFatalStatus(response.status);
        error.retryable = response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
      }

      const text = modelText(payload);
      if (!text) throw new Error("接口已返回，但没有文字内容；请确认模型支持图片输入");
      return parseScoreReply(text);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      // A bad key or malformed request will fail identically every time.
      if (error.fatal) throw error;
      if (error.retryable === undefined) error.retryable = true;
      if (attempt < retries && error.retryable) await sleep(1200 * (attempt + 1));
    }
  }
  throw lastError || new Error("识别失败");
}

/**
 * Run tasks with bounded concurrency.
 *
 * onSettled fires as each task finishes so the panel can update that row
 * immediately instead of waiting for the whole batch.
 */
export async function runPool(items, worker, { concurrency = 5, signal, onSettled } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  let fatalError = null;

  async function pump() {
    while (true) {
      if (signal?.aborted || fatalError) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        if (error.name === "AbortError") return;
        results[index] = { ok: false, error };
        // Auth/quota problems affect every remaining request; stop early
        // instead of burning the rest of the batch on the same failure.
        if (error.fatal) fatalError = error;
      }
      onSettled?.(index, results[index], items[index]);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, pump);
  await Promise.all(workers);
  if (fatalError) throw fatalError;
  return results;
}
