import { downloadXlsx } from "./xlsx.js";
import { readFileAsDataUrl, resizeDataUrl, fetchImageBlob, bitmapFromBlob, bitmapToDataUrl } from "./lib/image.js";
import { extractFeatures, featureSimilarity, applyThreshold, thresholdFor } from "./lib/local-filter.js";
import { scorePair, runPool, DIMENSIONS } from "./lib/vision.js";
import { textScore, composeFinalScore, parsePriceNumber, priceScore } from "./lib/text-match.js";
import { originPatternFor } from "./lib/api.js";
import { parseProductDataFile } from "./lib/data-import.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  tabId: null,
  meta: null,
  items: [],
  referenceDataUrl: "",
  referenceTitle: "",
  referenceKeywords: "",
  referencePrice: 0,
  productData: { fileName: "", headers: [], rows: [] },
  controller: null,
  running: false
};

const SETTINGS_KEY = "marketResearchSettings";
const REFERENCE_KEY = "marketResearchReference";
const REFERENCE_META_KEY = "marketResearchReferenceMeta";
const MERCHANT_RULES_KEY = "merchantListingRules";
const PRODUCT_DATA_KEY = "merchantProductData";
const RESEARCH_DATA_KEY = "marketResearchResults";

const SETTINGS_FIELDS = {
  endpoint: "#apiEndpoint",
  model: "#model",
  apiKey: "#apiKey",
  apiMode: "#apiMode",
  filterLevel: "#filterLevel",
  concurrency: "#concurrency",
  useVision: "#useVision",
  autoRetry: "#autoRetry",
  retryCount: "#retryCount",
  useDetails: "#useDetails"
};

const DETAIL_SCORE_CUTOFF = 0.9;
const MAX_DETAIL_TARGETS = 8;
let activePage = "dashboard";
let selectedTemplatePlatform = "otto";
const TEMPLATE_PLATFORM_LABELS = {
  otto: "OTTO",
  "real-vk": "REAL / VK",
  "cd-lml-but": "CD / LML / But",
  shein: "SHEIN",
  tk: "TK"
};
const DEFAULT_MERCHANT_RULES = {
  sku: {
    sourcePrefix: "EB-C-1-",
    targetPrefix: "EB-C-3-",
    defaultMultiplier: 1,
    pack2Source: "*2",
    pack2Target: "*6",
    pack2Note: "两件套规则",
    keepUnknown: true
  },
  price: {
    nonEuMinMargin: 1,
    euMinMargin: 10,
    launchUndercut: 2,
    priceDecimals: 2,
    platforms: {
      otto: { fee: "", shipping: "" },
      realVk: { fee: "", shipping: "" },
      cdLmlBut: { fee: "", shipping: "" },
      shein: { fee: "", shipping: "" },
      tk: { fee: "", shipping: "" }
    }
  },
  platform: {
    defaultShop: "",
    defaultWarehouse: "",
    defaultDeliveryDays: "",
    defaultStock: "",
    weightUnit: "g",
    dimensionUnit: "mm",
    defaultCategory: "",
    defaultBrand: ""
  },
  content: {
    language: "按平台站点语言",
    bannedWords: "",
    tone: "准确、简洁、可核验",
    noGuess: "品牌、认证、材质、尺寸、功能",
    requireKeywords: true,
    markUnknown: true
  }
};
const SUPPORTED_MARKETPLACES = [
  { id: "ebay", label: "eBay", domains: ["ebay.de", "ebay.com"] },
  { id: "otto", label: "OTTO", domains: ["otto.de"] },
  { id: "real", label: "Kaufland / REAL", domains: ["kaufland.de", "real.de"] },
  { id: "manomano-de", label: "ManoMano DE", domains: ["manomano.de"] },
  { id: "manomano-fr", label: "ManoMano FR", domains: ["manomano.fr"] },
  { id: "leroymerlin-fr", label: "Leroy Merlin FR", domains: ["leroymerlin.fr"] },
  { id: "cdiscount", label: "Cdiscount", domains: ["cdiscount.com"] },
  { id: "bol", label: "bol.com", domains: ["bol.com"] }
];

function marketplaceForUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return SUPPORTED_MARKETPLACES.find((marketplace) => marketplace.domains.some((domain) => host === domain || host.endsWith("." + domain))) || null;
  } catch {
    return null;
  }
}

function setStatus(message, type = "") {
  const element = $("#status");
  element.textContent = message;
  element.className = `status ${type}`.trim();
}

function showPage(pageId) {
  const page = document.querySelector('[data-page="' + pageId + '"]');
  if (!page) return;
  activePage = pageId;
  document.querySelectorAll(".page").forEach((node) => {
    const active = node === page;
    node.hidden = !active;
    node.classList.toggle("active", active);
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    const pageParent = page.dataset.pageParent || pageId;
    button.classList.toggle("active", button.dataset.pageTarget === pageParent);
  });
}

function selectTemplatePlatform(platform) {
  if (!TEMPLATE_PLATFORM_LABELS[platform]) return;
  selectedTemplatePlatform = platform;
  document.querySelectorAll("[data-template-platform]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.templatePlatform === platform);
  });
  $("#templatePlatformLabel").textContent = TEMPLATE_PLATFORM_LABELS[platform];
}

function updateDashboardTask() {
  const task = $("#dashboardTask");
  if (!task) return;
  if (!state.items.length) {
    task.textContent = "还没有开始任务";
    return;
  }
  const platform = state.meta?.platformLabel || "当前平台";
  task.textContent = platform + " · 已采集 " + state.items.length + " 个商品";
}

function updateTemplateInputStatus() {
  const productCount = state.productData.rows.length;
  const productLabel = productCount ? "已导入 " + productCount + " 条" : "未导入";
  const researchCount = state.items.length;
  const researchLabel = researchCount ? "已采集 " + researchCount + " 条" : "暂无结果";
  const productStatus = $("#productDataStatus");
  const researchStatus = $("#researchDataStatus");
  if (productStatus) {
    productStatus.textContent = productLabel;
    productStatus.className = "status-chip " + (productCount ? "ready" : "pending");
  }
  if (researchStatus) {
    researchStatus.textContent = researchLabel;
    researchStatus.className = "status-chip " + (researchCount ? "ready" : "pending");
  }
  const badge = $("#productImportBadge");
  if (badge) {
    badge.textContent = productCount ? productLabel : "未导入";
    badge.className = "page-badge" + (productCount ? " saved" : "");
  }
  const summary = $("#productImportSummary");
  if (summary) {
    summary.textContent = productCount
      ? state.productData.fileName + " · " + productCount + " 条产品资料 · " + state.productData.headers.length + " 个字段"
      : "尚未导入产品资料";
  }
}

function renderProductPreview() {
  const container = $("#productPreview");
  if (!container) return;
  const headers = state.productData.headers;
  const rows = state.productData.rows;
  if (!rows.length) {
    container.innerHTML = "";
    return;
  }
  const head = headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("");
  const body = rows.slice(0, 5).map((row) => "<tr>" + headers.map((header) => "<td>" + escapeHtml(row[header]) + "</td>").join("") + "</tr>").join("");
  container.innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
}

async function loadProductData() {
  const stored = (await chrome.storage.local.get(PRODUCT_DATA_KEY))[PRODUCT_DATA_KEY];
  if (!stored?.rows) return;
  state.productData = {
    fileName: String(stored.fileName || "已导入资料"),
    headers: Array.isArray(stored.headers) ? stored.headers : [],
    rows: Array.isArray(stored.rows) ? stored.rows : []
  };
  updateTemplateInputStatus();
  renderProductPreview();
}

async function loadResearchData() {
  const stored = (await chrome.storage.local.get(RESEARCH_DATA_KEY))[RESEARCH_DATA_KEY];
  if (!stored?.items) return;
  state.meta = stored.meta || null;
  state.items = Array.isArray(stored.items) ? stored.items : [];
  updateTemplateInputStatus();
  updateDashboardTask();
}

async function saveResearchData() {
  if (!state.items.length) return;
  const items = state.items.map((item) => {
    const copy = { ...item };
    delete copy.candidateImageSource;
    return copy;
  });
  await chrome.storage.local.set({
    [RESEARCH_DATA_KEY]: { meta: state.meta || {}, items }
  });
}

async function importProductData(file) {
  setStatus("正在读取产品资料…");
  try {
    const parsed = await parseProductDataFile(file);
    if (!parsed.rows.length) throw new Error("文件中没有可读取的数据行");
    state.productData = { fileName: file.name, headers: parsed.headers, rows: parsed.rows };
    await chrome.storage.local.set({ [PRODUCT_DATA_KEY]: state.productData });
    updateTemplateInputStatus();
    renderProductPreview();
    setStatus("已导入 " + parsed.rows.length + " 条产品资料", "success");
  } catch (error) {
    setStatus(error.message || "产品资料读取失败", "error");
  }
}

function renderResearchView() {
  const table = $("#researchTable");
  const stats = $("#researchStats");
  const subtitle = $("#researchViewSubtitle");
  if (!table || !stats) return;
  const filter = String($("#researchFilter")?.value || "").trim().toLowerCase();
  const visible = state.items.filter((item) => !filter || [item.title, item.price, item.shipping, item.seller, item.url, item.query].some((value) => String(value || "").toLowerCase().includes(filter)));
  stats.textContent = state.items.length ? "共 " + state.items.length + " 条 · 当前显示 " + visible.length + " 条" : "暂无调研结果";
  if (subtitle) subtitle.textContent = state.meta?.platformLabel ? state.meta.platformLabel + " · " + (state.meta.query || "当前搜索") : "查看当前已采集的竞品数据。";
  if (!visible.length) {
    table.innerHTML = '<div class="research-empty">暂无符合条件的调研结果</div>';
    return;
  }
  const rows = visible.map((item) => "<tr><td>" + item.rank + "</td><td><a href=\"" + escapeHtml(item.url) + "\" target=\"_blank\" rel=\"noreferrer\">" + escapeHtml(item.title) + "</a></td><td>" + escapeHtml(item.price || "") + "</td><td>" + escapeHtml(item.shipping || "") + "</td><td>" + escapeHtml(item.seller || "") + "</td><td class=\"score\">" + (Number.isFinite(item.finalScore) ? Math.round(item.finalScore * 100) + "%" : "—") + "</td></tr>").join("");
  table.innerHTML = "<table><thead><tr><th>#</th><th>商品</th><th>价格</th><th>运费</th><th>店铺</th><th>相似度</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

function mergeMerchantRules(value = {}) {
  return {
    ...DEFAULT_MERCHANT_RULES,
    ...value,
    sku: { ...DEFAULT_MERCHANT_RULES.sku, ...(value.sku || {}) },
    price: {
      ...DEFAULT_MERCHANT_RULES.price,
      ...(value.price || {}),
      platforms: {
        ...DEFAULT_MERCHANT_RULES.price.platforms,
        ...(value.price?.platforms || {})
      }
    },
    platform: { ...DEFAULT_MERCHANT_RULES.platform, ...(value.platform || {}) },
    content: { ...DEFAULT_MERCHANT_RULES.content, ...(value.content || {}) }
  };
}

function numberOrBlank(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const number = Number(text);
  return Number.isFinite(number) ? number : "";
}

function setInputValue(selector, value) {
  const element = $(selector);
  if (!element) return;
  if (element.type === "checkbox") element.checked = Boolean(value);
  else element.value = value == null ? "" : String(value);
}

function readMerchantRulesForm() {
  return mergeMerchantRules({
    sku: {
      sourcePrefix: $("#skuSourcePrefix").value.trim(),
      targetPrefix: $("#skuTargetPrefix").value.trim(),
      defaultMultiplier: numberOrBlank($("#skuDefaultMultiplier").value),
      pack2Source: $("#skuPack2Source").value.trim(),
      pack2Target: $("#skuPack2Target").value.trim(),
      pack2Note: $("#skuPack2Note").value.trim(),
      keepUnknown: $("#skuKeepUnknown").checked
    },
    price: {
      nonEuMinMargin: numberOrBlank($("#nonEuMinMargin").value),
      euMinMargin: numberOrBlank($("#euMinMargin").value),
      launchUndercut: numberOrBlank($("#launchUndercut").value),
      priceDecimals: numberOrBlank($("#priceDecimals").value),
      platforms: {
        otto: { fee: numberOrBlank($("#feeOtto").value), shipping: numberOrBlank($("#shippingOtto").value) },
        realVk: { fee: numberOrBlank($("#feeRealVk").value), shipping: numberOrBlank($("#shippingRealVk").value) },
        cdLmlBut: { fee: numberOrBlank($("#feeCdLmlBut").value), shipping: numberOrBlank($("#shippingCdLmlBut").value) },
        shein: { fee: numberOrBlank($("#feeShein").value), shipping: numberOrBlank($("#shippingShein").value) },
        tk: { fee: numberOrBlank($("#feeTk").value), shipping: numberOrBlank($("#shippingTk").value) }
      }
    },
    platform: {
      defaultShop: $("#defaultShop").value.trim(),
      defaultWarehouse: $("#defaultWarehouse").value.trim(),
      defaultDeliveryDays: $("#defaultDeliveryDays").value.trim(),
      defaultStock: numberOrBlank($("#defaultStock").value),
      weightUnit: $("#weightUnit").value.trim(),
      dimensionUnit: $("#dimensionUnit").value.trim(),
      defaultCategory: $("#defaultCategory").value.trim(),
      defaultBrand: $("#defaultBrand").value.trim()
    },
    content: {
      language: $("#contentLanguage").value.trim(),
      bannedWords: $("#contentBannedWords").value.trim(),
      tone: $("#contentTone").value.trim(),
      noGuess: $("#contentNoGuess").value.trim(),
      requireKeywords: $("#contentRequireKeywords").checked,
      markUnknown: $("#contentMarkUnknown").checked
    }
  });
}

function fillMerchantRulesForm(value) {
  const rules = mergeMerchantRules(value);
  const fields = {
    "#skuSourcePrefix": rules.sku.sourcePrefix,
    "#skuTargetPrefix": rules.sku.targetPrefix,
    "#skuDefaultMultiplier": rules.sku.defaultMultiplier,
    "#skuPack2Source": rules.sku.pack2Source,
    "#skuPack2Target": rules.sku.pack2Target,
    "#skuPack2Note": rules.sku.pack2Note,
    "#skuKeepUnknown": rules.sku.keepUnknown,
    "#nonEuMinMargin": rules.price.nonEuMinMargin,
    "#euMinMargin": rules.price.euMinMargin,
    "#launchUndercut": rules.price.launchUndercut,
    "#priceDecimals": rules.price.priceDecimals,
    "#feeOtto": rules.price.platforms.otto.fee,
    "#shippingOtto": rules.price.platforms.otto.shipping,
    "#feeRealVk": rules.price.platforms.realVk.fee,
    "#shippingRealVk": rules.price.platforms.realVk.shipping,
    "#feeCdLmlBut": rules.price.platforms.cdLmlBut.fee,
    "#shippingCdLmlBut": rules.price.platforms.cdLmlBut.shipping,
    "#feeShein": rules.price.platforms.shein.fee,
    "#shippingShein": rules.price.platforms.shein.shipping,
    "#feeTk": rules.price.platforms.tk.fee,
    "#shippingTk": rules.price.platforms.tk.shipping,
    "#defaultShop": rules.platform.defaultShop,
    "#defaultWarehouse": rules.platform.defaultWarehouse,
    "#defaultDeliveryDays": rules.platform.defaultDeliveryDays,
    "#defaultStock": rules.platform.defaultStock,
    "#weightUnit": rules.platform.weightUnit,
    "#dimensionUnit": rules.platform.dimensionUnit,
    "#defaultCategory": rules.platform.defaultCategory,
    "#defaultBrand": rules.platform.defaultBrand,
    "#contentLanguage": rules.content.language,
    "#contentBannedWords": rules.content.bannedWords,
    "#contentTone": rules.content.tone,
    "#contentNoGuess": rules.content.noGuess,
    "#contentRequireKeywords": rules.content.requireKeywords,
    "#contentMarkUnknown": rules.content.markUnknown
  };
  for (const [selector, valueToSet] of Object.entries(fields)) setInputValue(selector, valueToSet);
}

async function loadMerchantRules() {
  const stored = (await chrome.storage.local.get(MERCHANT_RULES_KEY))[MERCHANT_RULES_KEY];
  fillMerchantRulesForm(stored || DEFAULT_MERCHANT_RULES);
}

async function saveMerchantRules() {
  const rules = readMerchantRulesForm();
  await chrome.storage.local.set({ [MERCHANT_RULES_KEY]: rules });
  $("#rulesSaveState").textContent = "已保存";
  $("#rulesSaveState").className = "page-badge saved";
  setStatus("商家规则已保存，后续模板生成会读取这些规则。", "success");
}

async function resetMerchantRules() {
  fillMerchantRulesForm(DEFAULT_MERCHANT_RULES);
  await chrome.storage.local.set({ [MERCHANT_RULES_KEY]: DEFAULT_MERCHANT_RULES });
  $("#rulesSaveState").textContent = "已恢复初始规则";
  $("#rulesSaveState").className = "page-badge";
  setStatus("已恢复初始规则，尚未填写的平台费率和运费保持为空。", "success");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"
  }[char]));
}

function currentSettings() {
  const retryValue = $("#retryCount").value.trim();
  const retryCount = retryValue === "" ? 2 : Number(retryValue);
  return {
    endpoint: $("#apiEndpoint").value.trim().replace(/\/+$/, ""),
    model: $("#model").value.trim(),
    apiKey: $("#apiKey").value.trim(),
    apiMode: $("#apiMode").value,
    filterLevel: $("#filterLevel").value,
    concurrency: Math.min(10, Math.max(1, Number($("#concurrency").value) || 4)),
    useVision: $("#useVision").checked,
    autoRetry: $("#autoRetry").checked,
    retryCount: Number.isFinite(retryCount) ? Math.min(10, Math.max(0, Math.floor(retryCount))) : 2,
    useDetails: $("#useDetails").checked
  };
}

async function loadSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  for (const [key, selector] of Object.entries(SETTINGS_FIELDS)) {
    if (stored[key] === undefined) continue;
    const element = $(selector);
    if (element.type === "checkbox") element.checked = Boolean(stored[key]);
    else element.value = String(stored[key]);
  }
  if (stored.filterLevel === undefined) $("#filterLevel").value = "off";
  if (Number(stored.concurrency) > 10) $("#concurrency").value = "10";
  if (stored.retryCount === undefined) $("#retryCount").value = "2";
  else {
    const retryCount = Number(stored.retryCount);
    $("#retryCount").value = String(Number.isFinite(retryCount)
      ? Math.min(10, Math.max(0, Math.floor(retryCount)))
      : 2);
  }
  // Third-party gateways rarely implement the Responses shape.
  const endpoint = $("#apiEndpoint").value;
  if (endpoint && !/api\.openai\.com/i.test(endpoint) && $("#apiMode").value === "responses") {
    $("#apiMode").value = "chat";
  }
}

function saveSettings() {
  const saveState = $("#saveState");
  saveState.textContent = "保存中…";
  chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings() })
    .then(() => { saveState.textContent = "已保存"; })
    .catch(() => { saveState.textContent = "保存失败"; });
}

async function loadReference() {
  const stored = (await chrome.storage.local.get(REFERENCE_KEY))[REFERENCE_KEY];
  if (stored) setReference(stored, false);
  const meta = (await chrome.storage.local.get(REFERENCE_META_KEY))[REFERENCE_META_KEY] || {};
  state.referenceTitle = String(meta.title || "");
  state.referenceKeywords = String(meta.keywords || "");
  state.referencePrice = parsePriceNumber(meta.price) || 0;
  $("#referenceTitle").value = state.referenceTitle;
  $("#referenceKeywords").value = state.referenceKeywords;
  $("#referencePrice").value = meta.price || "";
}

function saveReferenceMeta() {
  const priceText = $("#referencePrice").value.trim();
  state.referenceTitle = $("#referenceTitle").value.trim();
  state.referenceKeywords = $("#referenceKeywords").value.trim();
  state.referencePrice = parsePriceNumber(priceText) || 0;
  chrome.storage.local.set({
    [REFERENCE_META_KEY]: { title: state.referenceTitle, keywords: state.referenceKeywords, price: priceText }
  }).catch(() => {});
}

function setReference(dataUrl, persist = true) {
  state.referenceDataUrl = dataUrl || "";
  const preview = $("#referencePreview");
  if (dataUrl) {
    preview.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="参考图">`;
    $("#clearReference").hidden = false;
    if (persist) chrome.storage.local.set({ [REFERENCE_KEY]: dataUrl }).catch(() => {});
  } else {
    preview.innerHTML = '<span class="reference-placeholder">未选择</span>';
    $("#clearReference").hidden = true;
    chrome.storage.local.remove(REFERENCE_KEY).catch(() => {});
  }
}

function fetchImageDataUrl(url, fallbackUrl) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "fetch-image", url, fallbackUrl }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) resolve("");
      else resolve(response.dataUrl || "");
    });
  });
}

function sendTabMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(state.tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

/** The content script may not be present yet on a tab that predates install. */
async function messageTab(message) {
  try {
    return await sendTabMessage(message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message || "")) {
      throw error;
    }
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["content.js"] });
    return await sendTabMessage(message);
  }
}

async function ensureEndpointPermission(endpoint) {
  const origin = originPatternFor(endpoint);
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  if (!(await chrome.permissions.request({ origins: [origin] }))) {
    throw new Error("未授予该 API 地址的访问权限");
  }
}

async function ensureImagePermissions(items) {
  const origins = [...new Set(items.map((item) => {
    try {
      const url = new URL(item.imageUrl);
      return /^https?:$/i.test(url.protocol) ? url.protocol + "//" + url.host + "/*" : "";
    } catch {
      return "";
    }
  }).filter(Boolean))].slice(0, 20);
  const missing = [];
  for (const origin of origins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  }
  if (missing.length && !(await chrome.permissions.request({ origins: missing }))) {
    throw new Error("未授予商品图片访问权限");
  }
}

function setProgress(done, total) {
  const progress = $("#progress");
  if (!total) { progress.hidden = true; return; }
  progress.hidden = false;
  $("#progressLabel").textContent = `已完成 ${done} / ${total}`;
  $("#progressBar").style.width = `${Math.round((done / total) * 100)}%`;
}

const VERDICT_CLASS = {
  "同款": "same",
  "高仿款": "replica",
  "同功能相似款": "similar",
  "同类不同款": "similar",
  "不相关": "unrelated"
};

function resultNode(item) {
  const node = document.createElement("article");
  node.className = "result";
  node.dataset.rank = String(item.rank);
  renderInto(node, item);
  return node;
}

function renderInto(node, item) {
  node.classList.toggle("pending", item.status === "pending");
  node.classList.toggle("failed", item.status === "failed");

  const total = Number.isFinite(item.finalScore) ? `${Math.round(item.finalScore * 100)}%` : "—";
  const verdictText = item.status === "failed" ? "识别失败" : item.verdict;
  const verdictClass = item.status === "failed" ? "error" : VERDICT_CLASS[item.verdict] || "";
  const verdictHtml = verdictText
    ? `<div class="verdict ${verdictClass}">${escapeHtml(verdictText)}</div>`
    : "";

  const dims = item.scores
    ? `<div class="dims">${DIMENSIONS.map((dimension) => {
        const value = item.scores[dimension.key];
        if (!Number.isFinite(value)) return "";
        return `<span>${dimension.label} <b>${Math.round(value * 100)}</b></span>`;
      }).join("")}</div>`
    : "";

  const scoreHints = [];
  if (Number.isFinite(item.visionScore)) scoreHints.push(`视觉 ${Math.round(item.visionScore * 100)}%`);
  if (Number.isFinite(item.localScore)) scoreHints.push(`图像粗筛 ${Math.round(item.localScore * 100)}%`);
  if (Number.isFinite(item.textScore)) scoreHints.push(`标题关键词 ${Math.round(item.textScore * 100)}%`);
  if (Number.isFinite(item.priceScore)) scoreHints.push(`价格 ${Math.round(item.priceScore * 100)}%`);
  const reason = item.reason || item.error || (item.status === "pending" ? "等待识别…" : "");

  node.innerHTML = `
    <img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy">
    <div class="result-main">
      <div class="result-head">
        <a class="result-title" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
        <span class="result-total">${total}</span>
      </div>
      <div class="result-meta">#${item.rank} · ${escapeHtml(item.price || "无价格")}${scoreHints.length ? ` · ${scoreHints.join(" · ")}` : ""}</div>
      ${verdictHtml}
      ${dims}
      ${reason ? `<div class="result-reason">${escapeHtml(reason)}</div>` : ""}
    </div>`;

  if (item.status === "failed") {
    const retry = document.createElement("button");
    retry.className = "retry";
    retry.textContent = "重试这一个";
    retry.addEventListener("click", () => retryOne(item.rank));
    node.querySelector(".result-main").appendChild(retry);
  }
}

function renderResults() {
  const container = $("#results");
  container.innerHTML = "";
  if (!state.items.length) {
    container.innerHTML = '<div class="empty">没有读取到商品，请确认当前是 ' + escapeHtml(state.meta?.platformLabel || "支持的电商平台") + ' 搜索结果页。</div>';
    return;
  }
  for (const item of sortedItems()) container.appendChild(resultNode(item));
}

function sortedItems() {
  // Scored items first by score; unscored keep their page order underneath.
  return [...state.items].sort((a, b) => {
    const left = Number.isFinite(a.finalScore) ? a.finalScore : -1;
    const right = Number.isFinite(b.finalScore) ? b.finalScore : -1;
    if (left !== right) return right - left;
    return a.rank - b.rank;
  });
}

function updateRow(item) {
  const node = $(`#results .result[data-rank="${item.rank}"]`);
  if (node) renderInto(node, item);
}

function updateSummary(extra = "") {
  const summary = $("#summary");
  summary.hidden = false;
  const same = state.items.filter((item) => item.verdict === "同款").length;
  const replica = state.items.filter((item) => item.verdict === "高仿款").length;
  const similar = state.items.filter((item) => item.verdict === "同功能相似款").length;
  const failed = state.items.filter((item) => item.status === "failed").length;
  const duplicateCount = Number(state.meta?.diagnostics?.duplicateCount || 0);
 const parts = [
    `${state.meta?.platformLabel || "当前平台"} · ${state.meta?.query || "当前搜索"} · 共 ${state.items.length} 个商品`,
    same || replica || similar ? `同款 ${same} 个 · 高仿 ${replica} 个 · 相似功能 ${similar} 个` : "",
    failed ? `识别失败 ${failed} 个` : "",
    duplicateCount ? ("已过滤重复商品 " + duplicateCount + " 个") : "",
    extra
  ].filter(Boolean);
  summary.textContent = parts.join(" · ");
  $("#retryFailed").disabled = state.running || failed === 0;
}

/** Score every candidate locally, then drop the clearly unrelated ones. */
async function parallelLocalPass(items, settings, reference) {
  let done = 0;
  const worker = async (item) => {
    let localScore = null;
    let candidateImageSource = null;
    if (item.imageUrl) {
      try {
        const prepared = await prepareCandidateImage(item, state.controller.signal);
        try {
          if (prepared.source) {
            localScore = featureSimilarity(reference, await extractFeatures(prepared.source));
            if (settings.useVision) candidateImageSource = prepared.source;
          }
        } finally {
          if (prepared.source !== candidateImageSource) prepared.close?.();
        }
      } catch (error) {
        if (error.name === "AbortError") throw error;
      }
    }
    const candidateTextScore = textScore({
      referenceTitle: state.referenceTitle,
      keywords: state.referenceKeywords,
      candidateTitle: item.title
    });
    const candidatePriceScore = priceScore(state.referencePrice, item.price);
    return {
      ...item,
      localScore,
      textScore: candidateTextScore,
      priceScore: candidatePriceScore,
      candidateImageSource,
      visionImageDataUrl: "",
      finalScore: composeFinalScore({
        localScore,
        textScore: candidateTextScore,
        priceScore: candidatePriceScore
      })
    };
  };
  const settled = await runPool(items, worker, {
    concurrency: Math.max(4, Math.min(12, Number(settings.concurrency) * 2 || 8)),
    signal: state.controller.signal,
    onSettled: () => {
      done += 1;
      if (done === items.length || done % 8 === 0) {
        setStatus("本地粗筛中… " + done + "/" + items.length);
      }
    }
  });
  const scored = settled.map((entry, index) => entry?.ok
    ? entry.value
    : { ...items[index], localScore: null, textScore: null, priceScore: null, candidateImageSource: null, visionImageDataUrl: "", finalScore: null });
  if (state.controller.signal.aborted) {
    for (const entry of scored) entry.candidateImageSource?.close?.();
    throw new DOMException("已停止", "AbortError");
  }
  const result = applyThreshold(scored, settings.filterLevel);
  for (const item of result.dropped) item.candidateImageSource?.close?.();
  return result;
}

async function prepareCandidateImage(item, signal) {
  const imageUrl = item.imageUrlLarge || item.imageUrl;
  try {
    const blob = await fetchImageBlob(imageUrl, item.imageUrl, signal);
    const bitmap = await bitmapFromBlob(blob);
    return {
      source: bitmap,
      close: () => bitmap.close?.()
    };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    const dataUrl = await fetchImageDataUrl(imageUrl, item.imageUrl);
    if (!dataUrl) return { source: null, visionImageDataUrl: "" };
    return {
      source: dataUrl
    };
  }
}

async function visionImageFor(item, signal) {
  if (item.visionImageDataUrl) return item.visionImageDataUrl;
  if (item.candidateImageSource) {
    const source = item.candidateImageSource;
    try {
      const dataUrl = typeof source === "string"
        ? await resizeDataUrl(source, 384, 0.72)
        : await bitmapToDataUrl(source, 384, 0.72);
      item.visionImageDataUrl = dataUrl;
      return dataUrl;
    } finally {
      source.close?.();
      delete item.candidateImageSource;
    }
  }
  const prepared = await prepareCandidateImage(item, signal);
  try {
    if (!prepared.source) return "";
    const dataUrl = typeof prepared.source === "string"
      ? await resizeDataUrl(prepared.source, 384, 0.72)
      : await bitmapToDataUrl(prepared.source, 384, 0.72);
    item.visionImageDataUrl = dataUrl;
    return dataUrl;
  } finally {
    prepared.close?.();
  }
}

async function localPass(items, settings) {
  const reference = await extractFeatures(state.referenceDataUrl);
  return parallelLocalPass(items, settings, reference);
}

async function visionPass(candidates, settings, progress = { done: 0, total: candidates.length }, referenceImageOverride = "") {
  const referenceImage = referenceImageOverride || await resizeDataUrl(state.referenceDataUrl, 384, 0.72);
  setProgress(progress.done, progress.total);

  const worker = async (item) => {
    const candidateImage = await visionImageFor(item, state.controller.signal);
    if (!candidateImage) throw new Error("没有取到商品图片");
    return scorePair({
      referenceImage,
      candidateImage,
      settings,
      referenceTitle: state.referenceTitle,
      keywords: state.referenceKeywords,
      candidateTitle: item.title,
      candidateDetails: item.details || "",
      referencePrice: state.referencePrice || "",
      candidatePrice: parsePriceNumber(item.price) || "",
      retries: settings.autoRetry ? settings.retryCount : 0,
      signal: state.controller.signal
    });
  };

  const onSettled = (_index, result, item) => {
    progress.done += 1;
    setProgress(progress.done, progress.total);
    const target = state.items.find((entry) => entry.rank === item.rank);
    if (!target) return;
    if (result.ok) {
      const candidateTextScore = textScore({
        referenceTitle: state.referenceTitle,
        keywords: state.referenceKeywords,
        candidateTitle: item.title
      });
      const candidatePriceScore = priceScore(state.referencePrice, item.price);
      Object.assign(target, {
        status: "done",
        scores: result.value.scores,
        visionScore: result.value.visionScore,
        verdict: result.value.verdict,
        reason: result.value.reason,
        textScore: candidateTextScore,
        priceScore: candidatePriceScore,
        finalScore: composeFinalScore({
          localScore: target.localScore,
          textScore: candidateTextScore,
          priceScore: candidatePriceScore,
          visionScore: result.value.visionScore,
          verdict: result.value.verdict
        }),
        error: ""
      });
    } else {
      Object.assign(target, { status: "failed", error: result.error.message || "识别失败" });
    }
    updateRow(target);
    updateSummary();
  };

  try {
    await runPool(candidates, worker, {
      concurrency: settings.concurrency,
      signal: state.controller.signal,
      onSettled
    });
  } finally {
    // Fatal API errors can leave queued ImageBitmaps untouched. Release them
    // before the next retry or analysis run.
    for (const item of candidates) {
      item.candidateImageSource?.close?.();
      delete item.candidateImageSource;
    }
  }
}

async function loadCandidateDetails(detailTargets) {
  if (!detailTargets.length) return;
  setStatus("读取非高度相似候选详情… 0/" + detailTargets.length);
  try {
    const detailResponse = await messageTab({
      type: "fetch-ebay-details",
      urls: detailTargets.map((item) => item.url)
    });
    if (!detailResponse?.ok) return;
    const details = detailResponse.details || {};
    for (const item of detailTargets) item.details = details[item.url] || "";
    setStatus("已读取候选详情 " + detailTargets.filter((item) => item.details).length + "/" + detailTargets.length);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    setStatus("候选详情读取失败，继续使用图片识别");
  }
}

function setRunning(running) {
  state.running = running;
  $("#analyze").disabled = running;
  $("#stop").hidden = !running;
  const failed = state.items.filter((item) => item.status === "failed").length;
  $("#retryFailed").disabled = running || failed === 0;
  $("#export").disabled = running || !state.items.length;
}

function releaseCandidateImages(items) {
  for (const item of items) {
    item.candidateImageSource?.close?.();
    delete item.candidateImageSource;
  }
}

async function retryFailed() {
  if (state.running) return;
  const failedItems = state.items.filter((item) => item.status === "failed");
  if (!failedItems.length) return;

  const settings = currentSettings();
  try {
    if (!state.referenceDataUrl) throw new Error("没有参考图，无法重试识别");
    if (!settings.apiKey) throw new Error("没有填写 API Key");
    if (!settings.model) throw new Error("没有填写模型名称");
    await ensureEndpointPermission(settings.endpoint);

    state.controller = new AbortController();
    for (const item of failedItems) {
      item.status = "pending";
      item.error = "";
      updateRow(item);
    }
    setRunning(true);
    setStatus("正在重试失败项（" + failedItems.length + " 个，并发 " + settings.concurrency + "）…");
    await visionPass(failedItems, settings);
    renderResults();

    const remaining = state.items.filter((item) => item.status === "failed").length;
    setStatus(remaining
      ? "重试完成，仍有 " + remaining + " 个失败"
      : "失败项已全部重试成功",
      remaining ? "" : "success");
  } catch (error) {
    if (error.name === "AbortError") setStatus("已停止，已完成的结果可以导出", "success");
    else setStatus(error.message || "重试失败", "error");
  } finally {
    releaseCandidateImages(state.items);
    setRunning(false);
    $("#export").disabled = !state.items.length;
  }
}

async function analyze() {
  const settings = currentSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });

  state.controller = new AbortController();
  setRunning(true);
  $("#summary").hidden = true;
  setProgress(0, 0);

  try {
    const useVision = settings.useVision && state.referenceDataUrl;
    if (useVision) {
      if (!settings.apiKey) throw new Error("已开启视觉模型比对，但没有填写 API Key");
      if (!settings.model) throw new Error("已开启视觉模型比对，但没有填写模型名称");
      await ensureEndpointPermission(settings.endpoint);
    }

    setStatus("正在读取当前平台商品…");
    const collected = await messageTab({ type: "collect-marketplace-page" });
    if (!collected?.ok) throw new Error(collected?.error || "无法读取当前平台搜索结果");
    state.meta = collected;
    updateTemplateInputStatus();
    updateDashboardTask();

    if (!collected.items.length) {
      const diagnostics = collected.diagnostics || {};
      throw new Error(
        `已读取 0 个商品。页面卡片=${collected.cardCount || 0}，商品链接=${diagnostics.itemLinkCount || 0}，` +
        `标题=${diagnostics.titleCount || 0}，图片=${diagnostics.imageCount || 0}。请刷新当前平台页面后重试。`
      );
    }

    if (!state.referenceDataUrl) {
      state.items = collected.items.map((item) => ({ ...item, status: "none" }));
      await saveResearchData();
      updateTemplateInputStatus();
      updateDashboardTask();
      renderResults();
      updateSummary("未上传参考图，仅采集");
      setStatus(`已采集 ${state.items.length} 个商品（未做相似度识别）`, "success");
      return;
    }

    if (useVision || state.referenceDataUrl) await ensureImagePermissions(collected.items);
    setStatus(`已读取 ${collected.items.length} 个商品，正在本地粗筛…`);
    const { kept, dropped } = await localPass(collected.items, settings);
    const threshold = thresholdFor(settings.filterLevel);
    const filterNote = threshold == null ? "未粗筛" : `粗筛保留 ${kept.length} / 已排除 ${dropped.length}`;

    state.items = [
      ...kept.map((item) => ({ ...item, status: useVision ? "pending" : "done" })),
      ...dropped.map((item) => ({ ...item, status: "filtered" }))
    ];
    await saveResearchData();
    updateTemplateInputStatus();
    updateDashboardTask();
    renderResults();
    updateSummary(filterNote);

    if (!useVision) {
      setStatus(`本地粗筛完成（${filterNote}）。开启视觉模型可大幅提升准确率。`, "success");
      return;
    }
    if (!kept.length) throw new Error("粗筛后没有剩余候选，请把粗筛强度调为「宽松」或「不筛」后重试");

    const referenceImage = await resizeDataUrl(state.referenceDataUrl, 384, 0.72);
    const detailTargets = settings.useDetails && !state.meta?.priceOnly
      ? [...kept]
        .filter((item) => !Number.isFinite(item.localScore) || item.localScore < DETAIL_SCORE_CUTOFF)
        .sort((left, right) => (right.finalScore || 0) - (left.finalScore || 0))
        .slice(0, MAX_DETAIL_TARGETS)
      : [];
    const detailRanks = new Set(detailTargets.map((item) => item.rank));
    const fastCandidates = kept.filter((item) => !detailRanks.has(item.rank));
    const progress = { done: 0, total: kept.length };
    const detailPromise = detailTargets.length
      ? loadCandidateDetails(detailTargets).catch((error) => {
        if (error.name === "AbortError") return;
      })
      : Promise.resolve();

    if (fastCandidates.length) {
      const fastLabel = detailTargets.length ? "初筛 ≥ 90%" : "候选";
      setStatus(`正在优先识别${fastLabel}（${fastCandidates.length} 个，并发 ${settings.concurrency}）…`);
      await visionPass(fastCandidates, settings, progress, referenceImage);
    } else if (!detailTargets.length) {
      setStatus("初筛相似度均 ≥ 90%，已跳过详情页");
    }
    await detailPromise;
    if (detailTargets.length) {
      setStatus(`正在识别非高度相似候选（${detailTargets.length} 个，并发 ${settings.concurrency}）…`);
      await visionPass(detailTargets, settings, progress, referenceImage);
    }

    await saveResearchData();
    renderResults();
    const failed = state.items.filter((item) => item.status === "failed").length;
    if (state.controller.signal.aborted) {
      setStatus("已停止，已完成的结果可以导出", "success");
    } else if (failed) {
      setStatus(`识别完成，其中 ${failed} 个失败，可单独重试`, "");
    } else {
      setStatus("识别完成", "success");
    }
  } catch (error) {
    if (error.name === "AbortError") setStatus("已停止，已完成的结果可以导出", "success");
    else setStatus(error.message || "处理失败", "error");
  } finally {
    setRunning(false);
    $("#export").disabled = !state.items.length;
  }
}

async function retryOne(rank) {
  const item = state.items.find((entry) => entry.rank === rank);
  if (!item || state.running) return;
  const settings = currentSettings();
  item.status = "pending";
  item.error = "";
  updateRow(item);
  try {
    const referenceImage = await resizeDataUrl(state.referenceDataUrl, 384, 0.72);
    const candidateImage = await visionImageFor(item);
    if (!candidateImage) throw new Error("没有取到商品图片");
    const result = await scorePair({
      referenceImage,
      candidateImage,
      settings,
      referenceTitle: state.referenceTitle,
      keywords: state.referenceKeywords,
      candidateTitle: item.title,
      candidateDetails: item.details || "",
      referencePrice: state.referencePrice || "",
      candidatePrice: parsePriceNumber(item.price) || "",
      retries: settings.autoRetry ? settings.retryCount : 0
    });
    const candidateTextScore = textScore({
      referenceTitle: state.referenceTitle,
      keywords: state.referenceKeywords,
      candidateTitle: item.title
    });
    const candidatePriceScore = priceScore(state.referencePrice, item.price);
    Object.assign(item, {
      status: "done",
      scores: result.scores,
      visionScore: result.visionScore,
      verdict: result.verdict,
      reason: result.reason,
      textScore: candidateTextScore,
      priceScore: candidatePriceScore,
      finalScore: composeFinalScore({
        localScore: item.localScore,
        textScore: candidateTextScore,
        priceScore: candidatePriceScore,
        visionScore: result.visionScore,
        verdict: result.verdict
      }),
      error: ""
    });
  } catch (error) {
    Object.assign(item, { status: "failed", error: error.message || "识别失败" });
  }
  updateRow(item);
  updateSummary();
}

async function refreshPageState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  const url = tab?.url || "";
  const marketplace = marketplaceForUrl(url);
  $("#pageState").textContent = marketplace
    ? marketplace.label + " · " + url
    : "请先打开支持的电商搜索结果页";
  $("#analyze").disabled = state.running || !marketplace;
  $("#useDetails").disabled = Boolean(marketplace && marketplace.id !== "ebay");
  if (marketplace && marketplace.id !== "ebay") $("#useDetails").checked = false;
}

async function initialize() {
  await loadSettings();
  await loadReference();
  await loadMerchantRules();
  await loadProductData();
  await loadResearchData();
  await refreshPageState();
  showPage("dashboard");
  selectTemplatePlatform("otto");

  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.pageTarget));
  });
  document.querySelectorAll("[data-go-page]").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.goPage));
  });
  document.querySelectorAll("[data-template-platform]").forEach((button) => {
    button.addEventListener("click", () => selectTemplatePlatform(button.dataset.templatePlatform));
  });
  document.querySelectorAll("[data-rule-action]").forEach((button) => {
    button.addEventListener("click", () => {
      showPage("rules");
      const section = document.querySelector('[data-rule-section="' + button.dataset.ruleAction + '"]');
      section?.scrollIntoView({ block: "start" });
      $("#rulesSaveState").textContent = "未修改";
      $("#rulesSaveState").className = "page-badge";
    });
  });
  $("#saveMerchantRules").addEventListener("click", saveMerchantRules);
  $("#resetMerchantRules").addEventListener("click", resetMerchantRules);
  document.querySelectorAll("[data-rule-section] input").forEach((input) => {
    input.addEventListener("input", () => {
      $("#rulesSaveState").textContent = "未保存";
      $("#rulesSaveState").className = "page-badge warning";
    });
    input.addEventListener("change", () => {
      $("#rulesSaveState").textContent = "未保存";
      $("#rulesSaveState").className = "page-badge warning";
    });
  });
  $("#generateTemplate").addEventListener("click", () => {
    showPage("templates");
    setStatus(TEMPLATE_PLATFORM_LABELS[selectedTemplatePlatform] + " 模板制作入口已准备，等待产品资料和商家规则。", "success");
  });
  $("#openProductImport").addEventListener("click", () => showPage("product-data"));
  $("#chooseProductData").addEventListener("click", () => $("#productDataFile").click());
  $("#productDataFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importProductData(file);
    event.target.value = "";
  });
  $("#openResearchView").addEventListener("click", () => {
    showPage("research-view");
    renderResearchView();
  });
  $("#researchFilter").addEventListener("input", renderResearchView);
  $("#researchViewExport").addEventListener("click", () => downloadXlsx(sortedItems(), state.meta || {}));

  // The panel stays open across tab switches, so keep the target tab current.
  chrome.tabs.onActivated.addListener(refreshPageState);
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === state.tabId && info.status === "complete") refreshPageState();
  });

  for (const selector of Object.values(SETTINGS_FIELDS)) {
    $(selector).addEventListener("change", saveSettings);
    $(selector).addEventListener("input", saveSettings);
  }

  $("#pickReference").addEventListener("click", () => $("#referenceImage").click());
  $("#clearReference").addEventListener("click", () => {
    setReference("");
    setStatus("已移除参考图");
  });
  $("#referenceTitle").addEventListener("input", saveReferenceMeta);
  $("#referenceKeywords").addEventListener("input", saveReferenceMeta);
  $("#referencePrice").addEventListener("input", saveReferenceMeta);
  $("#referenceImage").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setReference(await readFileAsDataUrl(file));
    setStatus("参考图已加载", "success");
    event.target.value = "";
  });

  $("#analyze").addEventListener("click", analyze);
  $("#retryFailed").addEventListener("click", retryFailed);
  $("#stop").addEventListener("click", () => {
    state.controller?.abort();
    setStatus("正在停止…");
  });
  $("#export").addEventListener("click", () => downloadXlsx(sortedItems(), state.meta || {}));
}

initialize();
