// Headless check of the DOM-free logic. Run: node verify.mjs
// test.html covers the same ground plus canvas-dependent paths in a browser.

import { gradientFeature, colorFeature, cosineSimilarity, histogramSimilarity, featureSimilarity, thresholdFor, applyThreshold, normalizeFraming, contentBounds } from "./lib/local-filter.js";
import { endpointUrl, apiModeFor, parseJsonObject, modelText, buildRequestBody } from "./lib/api.js";
import { parseScoreReply, weightedTotal, normalizeVerdict, runPool } from "./lib/vision.js";
import { ebayImageUrlAtSize } from "./lib/image.js";
import { textScore, blendScore, combineVisionScore, TEXT_WEIGHT, IMAGE_WEIGHT, LOCAL_WEIGHT, VISION_WEIGHT } from "./lib/text-match.js";

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { passed += 1; console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`); }
};
const section = (title) => console.log(`\n${title}`);

// Synthesise 64x64 RGBA product shots on a white background.
const SIZE = 64;
function render(inside, color) {
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const on = inside(x, y);
      pixels[offset] = on ? color[0] : 255;
      pixels[offset + 1] = on ? color[1] : 255;
      pixels[offset + 2] = on ? color[2] : 255;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
const circleOf = (radius) => (x, y) => Math.hypot(x - SIZE / 2, y - SIZE / 2) <= radius;
const squareOf = (half) => (x, y) => Math.abs(x - SIZE / 2) <= half && Math.abs(y - SIZE / 2) <= half;

const BLUE = [59, 110, 165];
const RED = [181, 63, 52];

const pxCircle = render(circleOf(20), BLUE);
const pxCircleSmall = render(circleOf(14), BLUE);
const pxCircleRed = render(circleOf(20), RED);
const pxSquare = render(squareOf(18), BLUE);

// Mirrors extractFeatures(): normalise framing, then measure.
const feature = (pixels) => {
  const framed = normalizeFraming(pixels, SIZE, SIZE);
  return { gradient: gradientFeature(framed, SIZE), color: colorFeature(framed) };
};
const fCircle = feature(pxCircle);
const fCircleSmall = feature(pxCircleSmall);
const fCircleRed = feature(pxCircleRed);
const fSquare = feature(pxSquare);

section("裁剪归一：消除取景差异");
const boundsSmall = contentBounds(pxCircleSmall, SIZE);
check("能框出商品范围", boundsSmall.width === 29 && boundsSmall.height === 29,
  `${boundsSmall.width}x${boundsSmall.height} @(${boundsSmall.x},${boundsSmall.y})`);
check("全白图回退为整幅", contentBounds(render(() => false, BLUE), SIZE).empty === true);

section("核心：梯度特征区分外形");
const sameShape = cosineSimilarity(fCircle.gradient, fCircleSmall.gradient);
const diffShape = cosineSimilarity(fCircle.gradient, fSquare.gradient);
check("同形不同大小 > 不同形状", sameShape > diffShape,
  `圆vs小圆=${sameShape.toFixed(3)} 圆vs方=${diffShape.toFixed(3)}`);
const shapeAcrossColor = cosineSimilarity(fCircle.gradient, fCircleRed.gradient);
check("同形不同色 形状相似度 > 0.95", shapeAcrossColor > 0.95, `=${shapeAcrossColor.toFixed(3)}`);
check("自身比对为 1", Math.abs(cosineSimilarity(fCircle.gradient, fCircle.gradient) - 1) < 1e-6);

section("综合打分：形状主导");
const sameShapeDiffColor = featureSimilarity(fCircle, fCircleRed);
const diffShapeSameColor = featureSimilarity(fCircle, fSquare);
check("同款不同配色 > 不同外形同配色", sameShapeDiffColor > diffShapeSameColor,
  `${sameShapeDiffColor.toFixed(3)} > ${diffShapeSameColor.toFixed(3)}`);

section("颜色特征忽略白底");
const colorCircle = colorFeature(pxCircle);
check("白底不计入", colorCircle.coverage > 0.05 && colorCircle.coverage < 0.5,
  `商品像素=${(colorCircle.coverage * 100).toFixed(1)}%`);
check("同色不同大小 分布接近",
  histogramSimilarity(colorCircle.buckets, colorFeature(pxCircleSmall).buckets) > 0.9);
const acrossColor = histogramSimilarity(colorCircle.buckets, colorFeature(pxCircleRed).buckets);
check("不同颜色 分布明显不同", acrossColor < 0.3, `=${acrossColor.toFixed(3)}`);

section("粗筛阈值");
check("适中=0.35", thresholdFor("medium") === 0.35);
check("不筛=null", thresholdFor("off") === null);
check("未知档回落适中", thresholdFor("nonsense") === 0.35);
const sample = [{ rank: 1, localScore: 0.8 }, { rank: 2, localScore: 0.3 }, { rank: 3, localScore: null }];
const mid = applyThreshold(sample, "medium");
check("低分被排除", mid.dropped.length === 1 && mid.dropped[0].rank === 2);
check("解码失败不排除", mid.kept.some((item) => item.rank === 3));
check("不筛档全保留", applyThreshold(sample, "off").kept.length === 3);
const rescued = applyThreshold([{ rank: 4, localScore: 0.1, textScore: 0.9 }], "medium");
check("标题关键词可救回低图像分", rescued.kept.length === 1 && rescued.dropped.length === 0);

section("eBay 图片地址改写");
check("225→500", ebayImageUrlAtSize("https://i.ebayimg.com/images/g/abc/s-l225.jpg", 500)
  === "https://i.ebayimg.com/images/g/abc/s-l500.jpg");
check("带查询参数", ebayImageUrlAtSize("https://i.ebayimg.com/images/g/abc/s-l225.jpg?x=1", 500)
  === "https://i.ebayimg.com/images/g/abc/s-l500.jpg");
check("非 eBay 原样", ebayImageUrlAtSize("https://example.com/a.jpg", 500) === "https://example.com/a.jpg");
check("空值安全", ebayImageUrlAtSize("", 500) === "");

section("接口地址规范化");
check("OpenAI→responses", endpointUrl("https://api.openai.com/v1", "auto").endsWith("/v1/responses"));
check("第三方→chat/completions", endpointUrl("https://x.example.com/v1", "chat").endsWith("/v1/chat/completions"));
check("responses→chat", endpointUrl("https://x.example.com/v1/responses", "chat").endsWith("/v1/chat/completions"));
check("重复调用稳定", endpointUrl(endpointUrl("https://api.openai.com/v1", "auto"), "auto").endsWith("/v1/responses"));
check("模式判定", apiModeFor("https://api.openai.com/v1", "auto") === "responses");
check("非法地址抛错", (() => { try { endpointUrl("not a url"); return false; } catch { return true; } })());

section("模型返回解析");
check("纯 JSON", parseJsonObject('{"a":1}').a === 1);
check("``` 包裹", parseJsonObject('```json\n{"a":2}\n```').a === 2);
check("夹带文字", parseJsonObject('好的：{"a":3} 以上').a === 3);
check("无 JSON 抛错", (() => { try { parseJsonObject("没有对象"); return false; } catch { return true; } })());
check("Chat 文本", modelText({ choices: [{ message: { content: "hi" } }] }) === "hi");
check("Responses 文本", modelText({ output_text: "hi" }) === "hi");
const contextualBody = buildRequestBody({ mode: "chat", model: "vision", instruction: "判断", referenceImage: "data:a", candidateImage: "data:b", referenceTitle: "三路电动猫玩具", keywords: "USB, 遥控, 三路", candidateTitle: "Elektrisch Interaktives Katzenspielzeug", candidateDetails: "Drei motorisierte Spielzeuge mit Fernbedienung und USB-Ladefunktion" });
check("标题和详情传入模型上下文", contextualBody.messages[0].content[0].text.includes("Drei motorisierte") && contextualBody.messages[0].content[0].text.includes("三路电动猫玩具"));

section("六维打分");
const reply = parseScoreReply('{"productType":90,"function":80,"shape":70,"structure":60,"material":50,"cost":40,"verdict":"同款","reason":"类型和功能一致"}');
check("归一到 0-1", Math.abs(reply.scores.productType - 0.9) < 1e-9);
check("加权总分", Math.abs(reply.visionScore - (0.9 * 0.25 + 0.8 * 0.25 + 0.7 * 0.20 + 0.6 * 0.15 + 0.5 * 0.10 + 0.4 * 0.05)) < 1e-9,
  `=${reply.visionScore.toFixed(4)}`);
check("判断标签", reply.verdict === "同款");
check("越界夹紧", parseScoreReply('{"productType":150,"function":-20,"shape":50,"structure":50,"material":50,"cost":50}').scores.productType === 1);
check("缺项按剩余权重归一", Math.abs(weightedTotal({ productType: 1, function: null, shape: null, structure: null, material: null, cost: null }) - 1) < 1e-9);
check("非法标签丢弃", normalizeVerdict("胡说") === "");
check("同功能相似款标签", normalizeVerdict("同功能相似款") === "同功能相似款");
check("全无效分数抛错", (() => { try { parseScoreReply('{"verdict":"同款"}'); return false; } catch { return true; } })());

section("标题关键词加权");
check("文字权重=40%", TEXT_WEIGHT === 0.4 && IMAGE_WEIGHT === 0.6);
const textHit = textScore({ referenceTitle: "Wireless Charger 15W Black", keywords: "15W, Black", candidateTitle: "Wireless Charger 15W Black" });
check("标题和关键词可命中", textHit === 1, "值=" + textHit);
check("图文合并按 60/40", Math.abs(blendScore(0.5, 1) - 0.7) < 1e-9);
check("最终本地/视觉按 40/60", LOCAL_WEIGHT === 0.4 && VISION_WEIGHT === 0.6 && Math.abs(combineVisionScore(0.5, 1) - 0.8) < 1e-9);

section("并发池");
const order = [];
const results = await runPool([1, 2, 3, 4, 5], async (value) => {
  await new Promise((resolve) => setTimeout(resolve, (6 - value) * 8));
  order.push(value);
  return value * 2;
}, { concurrency: 2 });
check("全部完成", results.length === 5 && results.every((entry) => entry.ok));
check("结果按输入顺序对齐", results[0].value === 2 && results[4].value === 10);
check("确实并发", order.join(",") !== "1,2,3,4,5", `完成顺序=${order.join(",")}`);

const withFailure = await runPool([1, 2, 3], async (value) => {
  if (value === 2) throw new Error("boom");
  return value;
}, { concurrency: 3 });
check("单个失败不影响其他", withFailure[0].ok && withFailure[2].ok);
check("失败项被标记", !withFailure[1].ok && withFailure[1].error.message === "boom");

const fatal = await runPool([1, 2, 3], async () => {
  const error = new Error("401");
  error.fatal = true;
  throw error;
}, { concurrency: 1 }).then(() => "没抛错").catch((error) => error.message);
check("致命错误中断整批", fatal === "401");

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
