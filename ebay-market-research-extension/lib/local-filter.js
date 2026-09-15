// Local pre-filter.
//
// Replaces the previous 32x32 average-brightness hash (aHash). That hash
// described overall light/dark distribution, which on white-background product
// photos changes with how much of the frame the object fills — it says nothing
// about shape. Gradient orientation histograms describe the contours
// themselves, which is what "same product" actually means.
//
// The functions below take raw pixel arrays so they can be tested without a DOM.

import { toPixelGrid } from "./image.js";

const GRID = 64;          // working resolution
const CELL = 8;           // 8x8 pixel cells -> 8x8 grid of cells
const BINS = 9;           // orientation bins spanning 0..180 degrees
const CELLS_PER_SIDE = GRID / CELL;

export const SHAPE_WEIGHT = 0.75;
export const COLOR_WEIGHT = 0.25;

export const FILTER_LEVELS = {
  strict: 0.5,
  medium: 0.35,
  loose: 0.2,
  off: null
};

function toGrayscale(pixels, size) {
  const gray = new Float32Array(size * size);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] =
      (0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2]) / 255;
  }
  return gray;
}

/**
 * Separable [1 2 1] blur.
 *
 * Listing thumbnails are heavily JPEG-compressed; the blocky high-frequency
 * noise otherwise produces spurious gradient votes that differ between two
 * photos of the same item. Two cheap 1-D passes approximate a Gaussian.
 */
export function blurGrayscale(gray, size) {
  const horizontal = new Float32Array(gray.length);
  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    for (let x = 0; x < size; x += 1) {
      const left = gray[row + Math.max(0, x - 1)];
      const middle = gray[row + x];
      const right = gray[row + Math.min(size - 1, x + 1)];
      horizontal[row + x] = (left + 2 * middle + right) / 4;
    }
  }
  const output = new Float32Array(gray.length);
  for (let y = 0; y < size; y += 1) {
    const up = Math.max(0, y - 1) * size;
    const middle = y * size;
    const down = Math.min(size - 1, y + 1) * size;
    for (let x = 0; x < size; x += 1) {
      output[middle + x] = (horizontal[up + x] + 2 * horizontal[middle + x] + horizontal[down + x]) / 4;
    }
  }
  return output;
}

function isBackground(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max > 237 && max - min < 16;
}

/**
 * Bounding box of the product within a white-background photo.
 *
 * Without this, two photos of the same item shot at different zoom levels
 * produce completely different features, because the spatial cells below bin
 * edges by absolute position. Marketplace listings frame products
 * inconsistently, so normalising framing is what makes the comparison fair.
 */
export function contentBounds(pixels, size) {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      if (isBackground(pixels[offset], pixels[offset + 1], pixels[offset + 2])) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // All-white or all-uniform image: treat the whole frame as content.
  if (maxX < 0) return { x: 0, y: 0, width: size, height: size, empty: true };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, empty: false };
}

/**
 * Resample the cropped region into a square of `target`, preserving aspect
 * ratio and padding with white. Aspect ratio is kept because a tall narrow
 * product and a square one are genuinely different shapes.
 */
export function normalizeFraming(pixels, size, target = GRID) {
  const bounds = contentBounds(pixels, size);
  const output = new Uint8ClampedArray(target * target * 4).fill(255);

  const scale = Math.min(target / bounds.width, target / bounds.height);
  const drawWidth = Math.max(1, Math.round(bounds.width * scale));
  const drawHeight = Math.max(1, Math.round(bounds.height * scale));
  const offsetX = Math.floor((target - drawWidth) / 2);
  const offsetY = Math.floor((target - drawHeight) / 2);

  for (let y = 0; y < drawHeight; y += 1) {
    const sourceY = Math.min(size - 1, bounds.y + Math.floor((y / drawHeight) * bounds.height));
    for (let x = 0; x < drawWidth; x += 1) {
      const sourceX = Math.min(size - 1, bounds.x + Math.floor((x / drawWidth) * bounds.width));
      const from = (sourceY * size + sourceX) * 4;
      const to = ((y + offsetY) * target + (x + offsetX)) * 4;
      output[to] = pixels[from];
      output[to + 1] = pixels[from + 1];
      output[to + 2] = pixels[from + 2];
      output[to + 3] = 255;
    }
  }
  return output;
}

/**
 * Histogram of oriented gradients.
 *
 * For each pixel we measure how brightness changes horizontally and vertically.
 * That gives an edge direction and strength. Votes are accumulated per cell into
 * orientation bins, then each cell is L2-normalised so local contrast changes
 * (lighting, JPEG quality) do not dominate.
 */
export function gradientFeature(pixels, size = GRID) {
  const gray = blurGrayscale(toGrayscale(pixels, size), size);
  const cellsPerSide = size / CELL;
  const feature = new Float32Array(cellsPerSide * cellsPerSide * BINS);

  const at = (x, y) => gray[y * size + x];

  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      const magnitude = Math.hypot(dx, dy);
      if (magnitude < 0.02) continue; // flat background contributes nothing

      // Unsigned orientation: an edge and its reverse are the same contour.
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI;
      const binPosition = (angle / Math.PI) * BINS;
      const lowBin = Math.floor(binPosition) % BINS;
      const highBin = (lowBin + 1) % BINS;
      const highShare = binPosition - Math.floor(binPosition);

      const cellX = Math.min(cellsPerSide - 1, Math.floor(x / CELL));
      const cellY = Math.min(cellsPerSide - 1, Math.floor(y / CELL));
      const base = (cellY * cellsPerSide + cellX) * BINS;

      // Split the vote between neighbouring bins so small rotations move the
      // feature smoothly instead of jumping between bins.
      feature[base + lowBin] += magnitude * (1 - highShare);
      feature[base + highBin] += magnitude * highShare;
    }
  }

  normalizeCells(feature, cellsPerSide);
  return feature;
}

/**
 * Per-cell L2 followed by 2x2 block normalisation (averaged over overlapping
 * blocks). Cell-only normalisation leaves a cell's response hostage to the
 * contrast of its own little patch; blocks let strong neighbouring edges share
 * the norm, which is what makes classic HOG robust to lighting and JPEG
 * quality differences between two photos of the same product.
 */
function normalizeCells(feature, cellsPerSide) {
  const cells = cellsPerSide * cellsPerSide;
  for (let cell = 0; cell < cells; cell += 1) {
    const base = cell * BINS;
    let sumSquares = 0;
    for (let bin = 0; bin < BINS; bin += 1) sumSquares += feature[base + bin] ** 2;
    const norm = Math.sqrt(sumSquares) || 1;
    for (let bin = 0; bin < BINS; bin += 1) feature[base + bin] /= norm;
  }

  const accumulated = new Float32Array(feature.length);
  const counts = new Float32Array(cells);
  for (let blockY = 0; blockY + 1 < cellsPerSide; blockY += 1) {
    for (let blockX = 0; blockX + 1 < cellsPerSide; blockX += 1) {
      const indices = [];
      let sumSquares = 0;
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const cell = (blockY + dy) * cellsPerSide + (blockX + dx);
          indices.push(cell);
          const base = cell * BINS;
          for (let bin = 0; bin < BINS; bin += 1) sumSquares += feature[base + bin] ** 2;
        }
      }
      const norm = Math.sqrt(sumSquares) || 1;
      for (const cell of indices) {
        const base = cell * BINS;
        for (let bin = 0; bin < BINS; bin += 1) accumulated[base + bin] += feature[base + bin] / norm;
        counts[cell] += 1;
      }
    }
  }
  for (let cell = 0; cell < cells; cell += 1) {
    const share = counts[cell] || 1;
    const base = cell * BINS;
    for (let bin = 0; bin < BINS; bin += 1) feature[base + bin] = accumulated[base + bin] / share;
  }
}

/**
 * Colour signature over the non-white pixels only.
 *
 * Marketplace photos are mostly white background; including it would make every
 * pair look alike. Hue/saturation buckets describe the product's own colouring.
 */
export function colorFeature(pixels) {
  const buckets = new Float32Array(32);
  let counted = 0;

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const r = pixels[offset] / 255;
    const g = pixels[offset + 1] / 255;
    const b = pixels[offset + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 0.93 && max - min < 0.06) continue; // white/near-white backdrop

    const delta = max - min;
    let hue = 0;
    if (delta > 0.0001) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    const saturation = max === 0 ? 0 : delta / max;

    // 8 hue buckets x 2 saturation levels x 2 brightness levels = 32.
    const hueBucket = Math.min(7, Math.floor(hue / 45));
    const saturationBucket = saturation < 0.25 ? 0 : 1;
    const valueBucket = max < 0.5 ? 0 : 1;
    buckets[hueBucket * 4 + saturationBucket * 2 + valueBucket] += 1;
    counted += 1;
  }

  if (!counted) return { buckets, coverage: 0 };
  for (let index = 0; index < buckets.length; index += 1) buckets[index] /= counted;
  return { buckets, coverage: counted / (pixels.length / 4) };
}

export function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator ? Math.max(0, dot / denominator) : 0;
}

export function histogramSimilarity(left, right) {
  // Intersection: the share of colour mass the two images agree on.
  let intersection = 0;
  for (let index = 0; index < left.length; index += 1) {
    intersection += Math.min(left[index], right[index]);
  }
  return Math.max(0, Math.min(1, intersection));
}

export function featureSimilarity(reference, candidate) {
  if (!reference || !candidate) return 0;
  const shape = cosineSimilarity(reference.gradient, candidate.gradient);
  const color = histogramSimilarity(reference.color.buckets, candidate.color.buckets);
  const combined = Math.max(0, Math.min(1, shape * SHAPE_WEIGHT + color * COLOR_WEIGHT));
  // Two products of different proportions (a tall narrow bottle vs a squat
  // box) keep similar HOG responses on their respective edges, so the aspect
  // ratio of the cropped subject adds a cheap, rotation-free discriminator.
  return combined * aspectAgreement(reference.aspect, candidate.aspect);
}

export function aspectAgreement(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return 1;
  const logRatio = Math.abs(Math.log(left / right));
  return Math.exp(-0.7 * logRatio);
}

export async function extractFeatures(dataUrl) {
  const raw = await toPixelGrid(dataUrl, GRID);
  // Crop to the product and rescale before measuring, so zoom level does not
  // change the result.
  const pixels = normalizeFraming(raw, GRID, GRID);
  const bounds = contentBounds(raw, GRID);
  const aspect = bounds.empty ? 1 : bounds.width / bounds.height;
  return {
    gradient: gradientFeature(pixels, GRID),
    color: colorFeature(pixels),
    aspect
  };
}

export function thresholdFor(level) {
  return Object.prototype.hasOwnProperty.call(FILTER_LEVELS, level)
    ? FILTER_LEVELS[level]
    : FILTER_LEVELS.medium;
}

/**
 * Score every candidate, then drop the clearly unrelated ones.
 *
 * This only subtracts to save API calls — it deliberately does not decide the
 * final ordering. Everything that survives goes to the vision model, which is
 * what makes the ranking trustworthy.
 */
export function applyThreshold(scored, level) {
  const threshold = thresholdFor(level);
  if (threshold == null) return { kept: scored.slice(), dropped: [] };
  const kept = [];
  const dropped = [];
  for (const item of scored) {
    const textRescue = Number.isFinite(item.textScore) && item.textScore >= 0.72;
    if (Number.isFinite(item.localScore) && (item.localScore >= threshold || textRescue)) kept.push(item);
    else if (!Number.isFinite(item.localScore)) kept.push(item); // never drop on a decode failure
    else dropped.push(item);
  }
  return { kept, dropped };
}
