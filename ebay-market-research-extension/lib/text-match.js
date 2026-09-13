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
