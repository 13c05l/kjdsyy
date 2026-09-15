// Title / keyword matching.
//
// Image similarity alone misses cases where the photo angle differs but the
// listing is plainly the same product, and it also can't tell a 1500W model
// from a 800W one that looks identical. Text carries that signal.
//
// All functions are pure so they can be checked from node and the browser.

export const TEXT_WEIGHT = 0.4;
export const IMAGE_WEIGHT = 1 - TEXT_WEIGHT;

// Marketplace filler that appears in almost every listing and would otherwise
// inflate every score. German + English, since this targets ebay.de / ebay.com.
const STOPWORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "und", "oder", "mit", "ohne", "für", "fuer", "von", "vom", "zum", "zur", "auf", "aus",
  "im", "in", "an", "am", "bei", "ist", "sind", "als", "auch", "sehr", "neu", "neue",
  "neuer", "neues", "gebraucht", "stück", "stueck", "set", "inkl", "inklusive", "versand",
  "kostenloser", "top", "sale", "angebot", "original", "hochwertig", "premium",
  "the", "a", "an", "and", "or", "with", "without", "for", "from", "of", "to", "in", "on",
  "is", "are", "new", "used", "free", "shipping", "lot", "pcs", "pack", "high", "quality",
  "best", "hot", "sale", "brand", "genuine", "us", "uk", "de", "eu"
]);

function isCjk(char) {
  const code = char.codePointAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/**
 * Split text into comparable tokens.
 *
 * Latin words are kept whole; CJK runs become overlapping bigrams so Chinese
 * input can still match Chinese text without a segmenter.
 */
export function tokenize(text) {
  const normalized = String(text || "").toLowerCase();
  const tokens = [];
  let latin = "";
  let cjk = "";

  const flushLatin = () => {
    if (latin.length >= 2 && !STOPWORDS.has(latin)) tokens.push(latin);
    else if (latin.length === 1 && /\d/.test(latin)) tokens.push(latin);
    latin = "";
  };
  const flushCjk = () => {
    if (cjk.length === 1) tokens.push(cjk);
    for (let index = 0; index + 1 < cjk.length; index += 1) {
      tokens.push(cjk.slice(index, index + 2));
    }
    cjk = "";
  };

  for (const char of normalized) {
    if (isCjk(char)) {
      flushLatin();
      cjk += char;
    } else if (/[a-z0-9]/.test(char)) {
      flushCjk();
      latin += char;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return tokens;
}

/** Tokens carrying a digit are model numbers, wattages, sizes — high signal. */
function tokenWeight(token) {
  return /\d/.test(token) ? 2 : 1;
}

function matchStrength(left, right) {
  if (left === right) return 1;
  // German compounds and plurals: akku / akkus, lampe / lampen.
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 4 && longer.startsWith(shorter)) return 0.8;
  return 0;
}

/** Best match for `token` anywhere in `tokens`. */
function bestMatch(token, tokens) {
  let best = 0;
  for (const candidate of tokens) {
    const strength = matchStrength(token, candidate);
    if (strength > best) best = strength;
    if (best === 1) break;
  }
  return best;
}

/**
 * Share of the reference tokens present in the candidate, weighted so that
 * model numbers count double.
 */
export function coverage(referenceTokens, candidateTokens) {
  if (!referenceTokens.length) return null;
  let matched = 0;
  let total = 0;
  for (const token of referenceTokens) {
    const weight = tokenWeight(token);
    total += weight;
    matched += weight * bestMatch(token, candidateTokens);
  }
  return total ? matched / total : null;
}

/**
 * Keywords are treated as requirements. A multi-word keyword ("wireless
 * charger") must appear as a phrase, so it isn't satisfied by the two words
 * showing up unrelated in a long title.
 */
export function keywordScore(keywords, candidateTitle) {
  const entries = String(keywords || "")
    .split(/[,，;；\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return null;

  const candidateTokens = tokenize(candidateTitle);
  const candidateText = String(candidateTitle || "").toLowerCase();
  let matched = 0;

  for (const entry of entries) {
    const entryTokens = tokenize(entry);
    if (!entryTokens.length) continue;
    if (entryTokens.length > 1) {
      // Phrase: accept a literal substring hit, else require every token.
      if (candidateText.includes(entry.toLowerCase())) matched += 1;
      else {
        const each = entryTokens.map((token) => bestMatch(token, candidateTokens));
        matched += each.every((value) => value > 0)
          ? each.reduce((sum, value) => sum + value, 0) / each.length * 0.7
          : 0;
      }
    } else {
      matched += bestMatch(entryTokens[0], candidateTokens);
    }
  }
  return matched / entries.length;
}

/**
 * Combined text score for one listing.
 *
 * Keywords dominate when supplied because they are the user's explicit "this
 * must be in there"; the reference title fills in broader context.
 */
export function textScore({ referenceTitle, keywords, candidateTitle }) {
  const fromKeywords = keywordScore(keywords, candidateTitle);
  const fromTitle = coverage(tokenize(referenceTitle), tokenize(candidateTitle));

  if (fromKeywords == null && fromTitle == null) return null;
  if (fromKeywords == null) return fromTitle;
  if (fromTitle == null) return fromKeywords;
  return fromKeywords * 0.65 + fromTitle * 0.35;
}

/**
 * Blend image and text. When one side is missing the other takes the full
 * weight, so an empty text box never drags every score toward zero.
 */
export function blendScore(imageScore, textValue) {
  const hasImage = Number.isFinite(imageScore);
  const hasText = Number.isFinite(textValue);
  if (hasImage && hasText) return imageScore * IMAGE_WEIGHT + textValue * TEXT_WEIGHT;
  if (hasImage) return imageScore;
  if (hasText) return textValue;
  return null;
}

// Final ranking combines the cheap local image signal with the pairwise model
// judgment. Titles and keywords remain context, but do not dominate the final
// product similarity score.
export const LOCAL_WEIGHT = 0.4;
export const VISION_WEIGHT = 0.6;

export function combineVisionScore(localScore, visionScore) {
  const hasLocal = Number.isFinite(localScore);
  const hasVision = Number.isFinite(visionScore);
  if (hasLocal && hasVision) return localScore * LOCAL_WEIGHT + visionScore * VISION_WEIGHT;
  if (hasVision) return visionScore;
  if (hasLocal) return localScore;
  return null;
}

// ---------------------------------------------------------------------------
// Final score composition.
//
// The image-only pipeline cannot separate two products that look alike (same
// shell, different wattage / piece count / brand). Titles and keywords carry
// exactly that signal, so they keep a permanent seat in the final score
// instead of being dropped once the vision model has spoken. Price is the
// remaining cheap signal: the same model rarely sells at twice the price.

// Base weights; each present signal is renormalised over the weights of the
// signals that actually have a value, so a missing input never drags scores.
export const FINAL_WEIGHTS = {
  vision: 0.5,
  text: 0.24,
  local: 0.16,
  price: 0.1
};

// Verdicts reorder near-ties: a confirmed same item outranks a lookalike even
// at equal raw scores, and an "unrelated" verdict should not sit above real
// matches just because the model scored it generously.
export const VERDICT_ADJUSTMENT = {
  "同款": 1.06,
  "高仿款": 0.96,
  "同功能相似款": 0.88,
  "不相关": 0.45
};

export function verdictAdjustment(verdict) {
  return VERDICT_ADJUSTMENT[verdict] ?? 1;
}

/**
 * Blend every available signal into the final 0-1 score.
 *
 * Accepts { localScore, textScore, visionScore, priceScore, verdict }; any
 * missing score is skipped. Without a vision score this reduces to the old
 * pre-vision blend (text 0.6 / local 0.4), so early rows keep their meaning.
 */
export function composeFinalScore({ localScore, textScore, visionScore, priceScore, verdict } = {}) {
  let total = 0;
  let weightUsed = 0;
  for (const [key, weight] of Object.entries(FINAL_WEIGHTS)) {
    const value = Number(key === "vision" ? visionScore : key === "text" ? textScore : key === "local" ? localScore : priceScore);
    if (!Number.isFinite(value)) continue;
    total += value * weight;
    weightUsed += weight;
  }
  if (!weightUsed) return null;
  const base = total / weightUsed;
  const adjusted = base * verdictAdjustment(verdict);
  return Math.max(0, Math.min(1, adjusted));
}

/**
 * Parse a marketplace price string into a bare number.
 *
 * Handles German formatting ("1.299,00 €", "EUR 12,99"), English ("$29.99",
 * "1,299.00") and plain numbers. Currency is irrelevant — callers only ever
 * compare two prices from the same listing set. Returns null when no number
 * can be recovered.
 */
export function parsePriceNumber(text) {
  const raw = String(text ?? "").replace(/\s|\u00a0/g, "");
  const match = raw.match(/-?\d[\d.,]*/);
  if (!match) return null;
  let digits = match[0];
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  if (lastComma > lastDot) {
    // 1.299,00 -> German: dots are thousands, comma is the decimal mark.
    digits = digits.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    // 1,299.00 -> English: commas are thousands.
    digits = digits.replace(/,/g, "");
  } else {
    digits = digits.replace(/,/g, "");
  }
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Price agreement in 0-1. Equal prices score 1; the score decays smoothly as
 * the relative gap grows, so a 20% gap stays high (~0.55) while the usual
 * "completely different product" 3x gap decays to near zero.
 */
export function priceScore(referencePrice, candidatePrice) {
  const reference = typeof referencePrice === "number" ? referencePrice : parsePriceNumber(referencePrice);
  const candidate = typeof candidatePrice === "number" ? candidatePrice : parsePriceNumber(candidatePrice);
  if (!Number.isFinite(reference) || reference <= 0 || !Number.isFinite(candidate) || candidate <= 0) return null;
  const gap = Math.abs(reference - candidate) / Math.max(reference, candidate);
  return Math.exp(-3 * gap);
}
