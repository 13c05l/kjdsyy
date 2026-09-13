// Endpoint normalisation and request-shape adaptation.
// Extracted unchanged in behaviour from the previous popup.js so existing
// user settings keep working.

export function normalizeEndpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function endpointUrl(endpoint, mode = "auto") {
  const value = normalizeEndpoint(endpoint);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API 地址格式不正确");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const isResponses =
    mode === "responses" ||
    (mode === "auto" && (/\/responses$/i.test(path) || url.hostname === "api.openai.com"));

  if (isResponses) {
    if (/\/chat\/completions$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/chat\/completions$/i, "/responses");
    } else if (!/\/responses$/i.test(url.pathname)) {
      url.pathname = `${path || "/v1"}/responses`;
    }
  } else {
    if (/\/responses$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/responses$/i, "/chat/completions");
    } else if (!/\/chat\/completions$/i.test(url.pathname)) {
      url.pathname = `${path || "/v1"}/chat/completions`;
    }
  }
  return url.toString();
}

export function apiModeFor(endpoint, mode = "auto") {
  return /\/responses(?:\?|$)/i.test(endpointUrl(endpoint, mode)) ? "responses" : "chat";
}

export function originPatternFor(endpoint) {
  try {
    const url = new URL(normalizeEndpoint(endpoint));
    return `${url.protocol}//${url.host}/*`;
  } catch {
    throw new Error("API 地址格式不正确");
  }
}

/** Pull assistant text out of either Responses or Chat Completions payloads. */
export function modelText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) {
    return payload.output
      .flatMap((part) => part.content || [])
      .map((part) => part.text || "")
      .join("");
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text || part.content || "").join("");
  return "";
}

/** Extract the first JSON object from a model reply that may be fenced or prosaic. */
export function parseJsonObject(text) {
  const fenced = String(text || "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text || "").trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型没有返回可解析的 JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function buildRequestBody({ mode, model, instruction, referenceImage, candidateImage, referenceTitle = "", keywords = "", candidateTitle = "", candidateDetails = "" }) {
  const context = [
    referenceTitle ? "参考商品标题：" + referenceTitle : "",
    keywords ? "参考关键词：" + keywords : "",
    candidateTitle ? "候选商品标题：" + candidateTitle : "",
    candidateDetails ? "候选商品详情摘要：" + candidateDetails : ""
  ].filter(Boolean).join("\n");
  const prompt = context ? instruction + "\n\n" + context : instruction;
  if (mode === "responses") {
    return {
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_text", text: "图 A（参考产品）：" },
            { type: "input_image", image_url: referenceImage },
            { type: "input_text", text: "图 B（候选商品）：" },
            { type: "input_image", image_url: candidateImage }
          ]
        }
      ]
    };
  }
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "text", text: "图 A（参考产品）：" },
          { type: "image_url", image_url: { url: referenceImage } },
          { type: "text", text: "图 B（候选商品）：" },
          { type: "image_url", image_url: { url: candidateImage } }
        ]
      }
    ]
  };
}

/** Errors that will never succeed on retry. */
export function isFatalStatus(status) {
  return status === 401 || status === 403 || status === 400 || status === 404;
}
