function normalizeText(value) {
  return String(value || "")
    .replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MARKETPLACES = [
  { id: "ebay", label: "eBay", domains: ["ebay.de", "ebay.com"], priceOnly: false },
  { id: "otto", label: "OTTO", domains: ["otto.de"], priceOnly: true,
    cardSelectors: ["[data-testid*='product']", "[data-qa*='product']", "article[class*='product']", "li[class*='product']"],
    linkPatterns: [/\/p\//i],
    titleSelectors: ["[data-testid*='product-name']", "[data-testid*='title']", "[class*='productName']", "[class*='product-name']", "h2", "h3"],
    priceSelectors: ["[data-testid*='price']", "[data-qa*='price']", "[class*='price']", "[class*='Price']"]
  },
  { id: "real", label: "Kaufland / REAL", domains: ["kaufland.de", "real.de"], priceOnly: true,
    cardSelectors: ["[data-testid*='product-card']", "[data-testid*='product']", "article[class*='product']", "li[class*='product']"],
    linkPatterns: [/\/product\//i, /\/p\//i],
    titleSelectors: ["[data-testid*='product-title']", "[data-testid*='title']", "[class*='product-title']", "[class*='ProductTitle']", "h2", "h3"],
    priceSelectors: ["[data-testid*='price']", "[data-qa*='price']", "[class*='price']", "[class*='Price']"]
  },
  { id: "manomano-de", label: "ManoMano DE", domains: ["manomano.de"], priceOnly: true,
    cardSelectors: ["[data-testid*='product-card']", "[data-testid*='product']", "li[class*='product']", "[class*='product-card']"],
    linkPatterns: [/\/p\//i, /\/mp\//i],
    titleSelectors: ["[data-testid*='product-name']", "[data-testid*='title']", "[class*='product-title']", "[class*='ProductTitle']", "h2", "h3"],
    priceSelectors: ["[data-testid*='price']", "[data-qa*='price']", "[class*='price']", "[class*='Price']"]
  },
  { id: "manomano-fr", label: "ManoMano FR", domains: ["manomano.fr"], priceOnly: true,
    cardSelectors: ["[data-testid*='product-card']", "[data-testid*='product']", "li[class*='product']", "[class*='product-card']"],
    linkPatterns: [/\/p\//i, /\/mp\//i],
    titleSelectors: ["[data-testid*='product-name']", "[data-testid*='title']", "[class*='product-title']", "[class*='ProductTitle']", "h2", "h3"],
    priceSelectors: ["[data-testid*='price']", "[data-qa*='price']", "[class*='price']", "[class*='Price']"]
  },
  { id: "leroymerlin-fr", label: "Leroy Merlin FR", domains: ["leroymerlin.fr"], priceOnly: true,
    cardSelectors: ["[data-testid*='product-card']", "[data-testid*='product']", "article[class*='product']", "li[class*='product']"],
    linkPatterns: [/\/produits\//i, /\/p\//i],
    titleSelectors: ["[data-testid*='product-name']", "[data-testid*='title']", "[class*='product-title']", "[class*='ProductTitle']", "h2", "h3"],
    priceSelectors: ["[data-testid*='price']", "[data-qa*='price']", "[class*='price']", "[class*='Price']"]
  },
  { id: "cdiscount", label: "Cdiscount", domains: ["cdiscount.com"], priceOnly: true,
    cardSelectors: ["[data-testid*='product-card']", "[data-testid*='product']", "article[class*='product']", "li[class*='product']", ".prdtBloc"],
    linkPatterns: [/\/dp\//i, /\/f-\d/i, /\/produit\//i],
    titleSelectors: ["[data-testid*='product-name']", "[data-testid*='title']", ".prdtTit", ".title", "[class*='product-title']", "h2", "h3"],
    priceSelectors: ["[data-testid*='price']", "[data-qa*='price']", ".price", ".prdtPrice", "[class*='price']", "[class*='Price']"]
  },
  { id: "bol", label: "bol.com", domains: ["bol.com"], priceOnly: true,
    cardSelectors: ["[data-testid*='product-item']", "[data-testid*='product']", "li[class*='product']", "[class*='product-item']"],
    linkPatterns: [/\/nl\/nl\/p\//i, /\/p\//i],
    titleSelectors: ["[data-testid*='product-title']", "[data-testid*='title']", "[class*='product-title']", "[class*='ProductTitle']", "h2", "h3"],
    priceSelectors: ["[data-testid*='price']", "[data-qa*='price']", "[class*='price']", "[class*='Price']"]
  }
];

function marketplaceForLocation() {
  const host = location.hostname.toLowerCase();
  return MARKETPLACES.find((marketplace) => marketplace.domains.some((domain) => host === domain || host.endsWith("." + domain))) || null;
}

function textFrom(selectors, root = document) {
  for (const selector of selectors) {
    if (root.matches?.(selector)) {
      const ownValue = normalizeText(root.textContent);
      if (ownValue) return ownValue;
    }
    const element = root.querySelector(selector);
    const value = normalizeText(element?.textContent);
    if (value) return value;
  }
  return "";
}

function attrFrom(selectors, attribute, root = document) {
  for (const selector of selectors) {
    if (root.matches?.(selector)) {
      const ownValue = root.getAttribute(attribute);
      if (ownValue) return ownValue;
    }
    const value = root.querySelector(selector)?.getAttribute(attribute);
    if (value) return value;
  }
  return "";
}

function cleanImageUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, location.href);
    if (/ebayimg\.com/i.test(url.hostname)) url.search = "";
    return url.href;
  } catch {
    return value;
  }
}

/**
 * eBay image paths end in a size token like `s-l225.jpg`. The rendered card
 * uses a small thumbnail; rewriting the token gives a much larger version of
 * the same photo, which is what the vision model needs to judge shape and
 * material. The original stays as a fallback in case the variant 404s.
 */
function largeImageUrl(value, size = 500) {
  if (!value || !/ebayimg\.com/i.test(value)) return value;
  return value.replace(/\/s-l\d+(\.[a-z]+)$/i, `/s-l${size}$1`);
}


function imageFromCard(card) {
  const images = [...card.querySelectorAll("img")];
  for (const image of images) {
    const candidates = [
      image.getAttribute("data-zoom-src"),
      image.getAttribute("data-src"),
      image.getAttribute("data-lazy-src"),
      image.getAttribute("data-original"),
      image.getAttribute("data-srcset")?.split(",").pop()?.trim().split(" ")[0],
      ...[...image.closest("picture")?.querySelectorAll("source[srcset]") || []]
        .flatMap((source) => source.getAttribute("srcset")?.split(",").pop()?.trim().split(" ") || []),
      image.currentSrc,
      image.getAttribute("src"),
      image.getAttribute("srcset")?.split(",").pop()?.trim().split(" ")[0]
    ];
    const value = candidates.find((candidate) => candidate && !/transparent|placeholder|pixel\.gif|data:image/i.test(candidate));
    if (value) return cleanImageUrl(value);
  }
  return "";
}

function genericCardList(config) {
  const cards = [];
  const seen = new Set();
  const add = (card) => {
    if (card && !seen.has(card)) {
      seen.add(card);
      cards.push(card);
    }
  };
  const matchesLink = (href) => (config.linkPatterns || []).some((pattern) => pattern.test(href));

  // Start from product links. This avoids treating a whole result grid as one
  // card when a marketplace wraps several products in one article/container.
  for (const link of document.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (!matchesLink(href)) continue;
    const card = link.closest("li, [role='listitem'], article[class*='product'], [class*='product-card'], [class*='product-item'], [data-testid*='product-card'], [data-testid*='product-item'], [data-testid*='product'], [data-qa*='product']") || link.parentElement;
    add(card);
  }

  // Use configured card selectors only when the element represents one link.
  for (const selector of config.cardSelectors || []) {
    for (const card of document.querySelectorAll(selector)) {
      const links = [...card.querySelectorAll("a[href]")].filter((link) => matchesLink(link.getAttribute("href") || ""));
      if (links.length <= 1 && (links.length || matchesLink(card.getAttribute("href") || ""))) add(card);
    }
  }
  return cards;
}

function genericLinkFromCard(card, config) {
  const links = card.matches?.("a[href]") ? [card] : [...card.querySelectorAll("a[href]")];
  const matchesLink = (href) => (config.linkPatterns || []).some((pattern) => pattern.test(href));
  const link = links.find((candidate) => matchesLink(candidate.getAttribute("href") || ""));
  return link?.getAttribute("href") || link?.href || "";
}

function genericTitleFromCard(card, config) {
  const title = textFrom(config.titleSelectors || [], card);
  return title
    || normalizeText(attrFrom(["a[title]"], "title", card))
    || normalizeText(attrFrom(["img[alt]"], "alt", card));
}

function normalizePrice(value) {
  const text = normalizeText(value);
  const match = text.match(/(?:[$£€]\s?\d{1,3}(?:[.\s]\d{3})*(?:[,.]\d{2})?|\d{1,3}(?:[.\s]\d{3})*(?:[,.]\d{2})?\s?(?:€|EUR|CHF|£|GBP|\$|USD|PLN|kr))/i);
  return match ? normalizeText(match[0]) : text.slice(0, 80);
}

function genericPriceFromCard(card, config) {
  const values = [];
  for (const selector of config.priceSelectors || []) {
    for (const element of card.querySelectorAll(selector)) {
      values.push(element.getAttribute("content") || element.textContent || "");
    }
  }
  const itemProp = card.querySelector("[itemprop='price']");
  if (itemProp) values.push(itemProp.getAttribute("content") || itemProp.textContent || "");
  const metaPrice = card.querySelector("meta[property='product:price:amount'], meta[name='price']");
  if (metaPrice) values.push(metaPrice.getAttribute("content") || "");
  return normalizePrice(values.find((value) => /\d/.test(value)) || "");
}

function productsFromJsonLd() {
  const items = [];
  for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
    try {
      const payload = JSON.parse(script.textContent || "{}");
      const candidates = Array.isArray(payload)
        ? payload
        : [payload, ...(payload?.["@graph"] || []), ...(payload?.itemListElement || []).map((entry) => entry?.item || entry)];
      for (const product of candidates) {
        const type = product?.["@type"];
        if (type !== "Product" && product?.name === undefined) continue;
        const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
        const rawImage = Array.isArray(product.image) ? product.image[0] : product.image;
        const image = typeof rawImage === "object" ? rawImage?.url : rawImage;
        const url = product.url || offer?.url;
        if (!product.name || !image || !url) continue;
        const price = offer?.price ?? offer?.lowPrice ?? product.price;
        items.push({
          title: normalizeText(product.name),
          price: normalizePrice([price, offer?.priceCurrency].filter(Boolean).join(" ")),
          imageUrl: cleanImageUrl(image),
          url: new URL(url, location.href).href
        });
      }
    } catch {}
  }
  return items;
}

function cardList() {
  const selectors = [
    "li.s-item",
    "li.s-card",
    ".su-card-container",
    "article.s-card",
    "div.s-card",
    "[data-testid='item-card']",
    "[data-testid='item']"
  ];
  const cards = [];
  const seen = new Set();
  for (const selector of selectors) {
    for (const card of document.querySelectorAll(selector)) {
      if (!seen.has(card)) {
        seen.add(card);
        cards.push(card);
      }
    }
  }

  // Always include item-link ancestors because eBay may mix old and new card layouts.
  for (const link of document.querySelectorAll("a[href*='/itm/']")) {
    const card = link.closest("li, article, [class*='card'], [data-testid], [role='listitem']") || link.parentElement;
    if (card && !seen.has(card)) {
      seen.add(card);
      cards.push(card);
    }
  }
  return cards;
}

function linkFromCard(card) {
  const selectors = [
    ".s-item__link[href]",
    "a.s-card__link[href*='/itm/']",
    "a[href*='/itm/']"
  ];
  if (card.matches?.("a[href*='/itm/']")) return card.getAttribute("href") || "";
  for (const selector of selectors) {
    const link = card.querySelector(selector)?.getAttribute("href");
    if (link) return link;
  }
  return "";
}

function titleFromCard(card) {
  return textFrom([
    ".s-item__title",
    ".s-card__title",
    ".su-card-container__title",
    "[class*='card__title']",
    "h3",
    "h2",
    "a[href*='/itm/'][aria-label]",
    "a[href*='/itm/'][title]"
  ], card) || normalizeText(attrFrom(["a[href*='/itm/'][aria-label]"], "aria-label", card)) || normalizeText(attrFrom(["a[href*='/itm/'][title]"], "title", card));
}

function isPlaceholder(title, link, card) {
  const cleanTitle = normalizeText(title).toLowerCase();
  if (!title || !link) return true;
  if (/shop on ebay|no results|access denied|pardon our interruption/i.test(cleanTitle)) return true;
  if (card.getAttribute("data-listingid") === "123456") return true;
  return /\/itm\/123456(?:[/?#]|$)/i.test(link);
}

function extractSearchKeyword() {
  const input = document.querySelector('input[name="_nkw"], input[name="q"], input[type="search"], input[aria-label*="Search"], input[aria-label*="Recherche"], input[data-testid*="search"]');
  if (input?.value) return input.value.trim();
  const params = new URLSearchParams(location.search);
  return params.get("_nkw") || params.get("q") || params.get("query") || params.get("search") || params.get("keyword") || "";
}

function collectNow() {
  const cards = cardList();
  const items = [];
  const seen = new Set();

  for (const card of cards) {
    const title = titleFromCard(card);
    const link = linkFromCard(card);
    const image = imageFromCard(card);
    if (isPlaceholder(title, link, card)) continue;
    const absoluteLink = new URL(link, location.href).href;
    const identity = itemIdentityKey(absoluteLink);
    if (seen.has(identity)) continue;
    seen.add(identity);

    items.push({
      rank: items.length + 1,
      title,
      price: textFrom([".s-item__price", ".s-card__price", "[class*='card__price']", "[class*='price']"], card),
      shipping: textFrom([".s-item__shipping", ".s-item__logisticsCost", ".s-card__attribute-row", ".s-card__footer--row"], card),
      condition: textFrom([".SECONDARY_INFO", ".s-card__subtitle", ".s-card__attribute-row"], card),
      seller: textFrom([".s-item__seller-info-text", ".s-card__seller", "[class*='seller']"], card),
      imageUrl: image,
      imageUrlLarge: largeImageUrl(image),
      url: absoluteLink,
      query: extractSearchKeyword()
    });
  }

  return {
    ok: true,
    platform: "ebay",
    platformLabel: "eBay",
    priceOnly: false,
    sourceUrl: location.href,
    query: extractSearchKeyword(),
    collectedAt: new Date().toISOString(),
    cardCount: cards.length,
    items,
    diagnostics: {
      pageTitle: document.title,
      hasSItem: document.querySelectorAll("li.s-item").length,
      hasSCard: document.querySelectorAll("li.s-card").length,
      hasSuCard: document.querySelectorAll(".su-card-container").length,
      titleCount: document.querySelectorAll(".s-item__title, .s-card__title, .su-card-container__title").length,
      imageCount: document.querySelectorAll(".s-item__image, .s-card__image, .su-card-container img, img").length,
      itemLinkCount: document.querySelectorAll("a[href*='/itm/']").length
    }
  };
}

function collectGenericNow(config) {
  const cards = genericCardList(config);
  const items = [];
  const seen = new Set();
  const query = extractSearchKeyword();

  for (const card of cards) {
    const title = genericTitleFromCard(card, config);
    const link = genericLinkFromCard(card, config);
    const image = imageFromCard(card);
    // Images can still be lazy while the title/link are already present. Keep
    // the product and let the next scroll sample fill the image URL.
    if (!title || !link) continue;
    const absoluteLink = new URL(link, location.href).href;
    const identity = itemIdentityKey(absoluteLink);
    if (seen.has(identity)) continue;
    seen.add(identity);
    items.push({
      rank: items.length + 1,
      title,
      price: genericPriceFromCard(card, config),
      shipping: "",
      condition: "",
      seller: "",
      imageUrl: image,
      imageUrlLarge: image,
      url: absoluteLink,
      query
    });
  }

  // JSON-LD often contains products that have not been mounted into the
  // virtualised DOM yet. Merge it on every sample instead of using it only
  // when the card query returns zero items.
  for (const product of productsFromJsonLd()) {
    const identity = itemIdentityKey(product.url);
    if (seen.has(identity)) continue;
    seen.add(identity);
    items.push({
      rank: items.length + 1,
      ...product,
      shipping: "",
      condition: "",
      seller: "",
      imageUrlLarge: product.imageUrl,
      query
    });
  }

  return {
    ok: true,
    platform: config.id,
    platformLabel: config.label,
    priceOnly: true,
    sourceUrl: location.href,
    query,
    collectedAt: new Date().toISOString(),
    cardCount: cards.length,
    items,
    diagnostics: {
      pageTitle: document.title,
      titleCount: cards.filter((card) => genericTitleFromCard(card, config)).length,
      imageCount: cards.reduce((count, card) => count + card.querySelectorAll("img").length, 0),
      itemLinkCount: cards.filter((card) => genericLinkFromCard(card, config)).length,
      jsonLdFallback: !cards.length || !items.length
    }
  };
}

function canonicalItemUrl(value) {
  try {
    const url = new URL(value, location.href);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|msclkid$|ref$|referrer$|source$|campaign$|clickid$|aff(id|iliate)?$|tracking$|track$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.href;
  } catch {
    return value;
  }
}

function itemIdentityKey(value) {
  const canonical = canonicalItemUrl(value);
  try {
    const url = new URL(canonical, location.href);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (/ebay\./i.test(host)) {
      const match = url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{8,14})(?:\/|$)/i);
      if (match) return "ebay:" + match[1];
    }
    return host + url.pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return canonical;
  }
}

function mergeCollectedItems(target, incoming) {
  const byIdentity = new Map(target.map((item) => [itemIdentityKey(item.url), item]));
  let added = 0;
  let duplicates = 0;
  for (const item of incoming) {
    const url = canonicalItemUrl(item.url);
    if (!url) continue;
    const identity = itemIdentityKey(url);
    const existing = byIdentity.get(identity);
    if (existing) {
      duplicates += 1;
      for (const [key, value] of Object.entries(item)) {
        if (key !== "rank" && value !== "" && value != null) existing[key] = value;
      }
    } else {
      const copy = { ...item, url };
      target.push(copy);
      byIdentity.set(identity, copy);
      added += 1;
    }
  }
  target.forEach((item, index) => { item.rank = index + 1; });
  return { added, duplicates };
}

function uniqueItems(items) {
  const result = [];
  const byIdentity = new Map();
  for (const item of items) {
    const identity = itemIdentityKey(item.url);
    const existing = byIdentity.get(identity);
    if (existing) {
      for (const [key, value] of Object.entries(item)) {
        if (key !== "rank" && value !== "" && value != null) existing[key] = value;
      }
    } else {
      const copy = { ...item, url: canonicalItemUrl(item.url) };
      result.push(copy);
      byIdentity.set(identity, copy);
    }
  }
  result.forEach((item, index) => { item.rank = index + 1; });
  return result;
}

function pageScrollHeight() {
  return Math.max(
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0,
    document.documentElement?.offsetHeight || 0,
    document.body?.offsetHeight || 0
  );
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDynamicItems(collector, items, timeout = 1100, onMerge) {
  const deadline = Date.now() + timeout;
  const startedAt = Date.now();
  let quietSamples = 0;
  let duplicateCount = 0;
  while (Date.now() < deadline) {
    const before = items.length;
    const sample = collector();
    const merged = mergeCollectedItems(items, sample.items || []);
    duplicateCount += merged.duplicates;
    onMerge?.(merged);
    if (items.length > before) quietSamples = 0;
    else quietSamples += 1;
    // Keep a short minimum settling window so a slow virtual list can append
    // after the scroll event before the collector moves on.
    if (quietSamples >= 3 && Date.now() - startedAt >= 360) break;
    await wait(120);
  }
  return duplicateCount;
}

function productLinkCount(root, config) {
  const patterns = config?.linkPatterns || [/\/itm\//i];
  return [...root.querySelectorAll("a[href]")].filter((link) =>
    patterns.some((pattern) => pattern.test(link.getAttribute("href") || ""))).length;
}

function findScrollTarget(config) {
  const page = document.scrollingElement || document.documentElement;
  const viewport = Math.max(window.innerHeight || 800, 600);
  const pageDistance = Math.max(0, page.scrollHeight - viewport);
  let best = null;
  let bestScore = pageDistance > 80 ? 0 : -1;

  // Prefer a scrollable ancestor that actually contains product links. Some
  // marketplaces keep the page short and virtualise results inside a panel.
  for (const element of document.querySelectorAll("body *")) {
    if (element.scrollHeight <= element.clientHeight + 120 || element.clientHeight < 260) continue;
    const style = getComputedStyle(element);
    if (!/(auto|scroll)/i.test(style.overflowY)) continue;
    const links = productLinkCount(element, config);
    if (!links) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 240 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const distance = element.scrollHeight - element.clientHeight;
    const score = distance + links * 20;
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }

  return best ? { element: best } : { element: null };
}

function scrollPosition(target) {
  return target.element ? target.element.scrollTop : (window.scrollY || document.documentElement.scrollTop || 0);
}

function scrollViewport(target) {
  return target.element ? target.element.clientHeight : Math.max(window.innerHeight || 800, 600);
}

function scrollHeight(target) {
  return target.element ? target.element.scrollHeight : pageScrollHeight();
}

function scrollToPosition(target, position) {
  const before = scrollPosition(target);
  if (target.element) {
    target.element.scrollTop = position;
    target.element.scrollTo?.({ top: position, behavior: "auto" });
  } else {
    const page = document.scrollingElement || document.documentElement;
    page.scrollTop = position;
    if (document.body) document.body.scrollTop = position;
    window.scrollTo(0, position);
  }
  return { before, after: scrollPosition(target), moved: Math.abs(scrollPosition(target) - before) > 2 };
}

const LOAD_MORE_RE = /load more|show more|加载更多|显示更多|mehr anzeigen|weitere produkte|weitere artikel|afficher plus|voir plus|plus de produits|meer tonen|toon meer|meer producten/i;

function clickLoadMore(target, clickState, itemCount) {
  const candidates = [...document.querySelectorAll("button, [role='button'], a")];
  for (const element of candidates) {
    if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
    const text = normalizeText((element.textContent || "") + " " + (element.getAttribute("aria-label") || ""));
    if (!LOAD_MORE_RE.test(text)) continue;
    const previous = clickState?.get(text);
    // Many marketplaces reuse the same button node. Do not click it again
    // until the previous click actually produced more products.
    if (previous && itemCount <= previous.itemCount) continue;
    const rect = element.getBoundingClientRect();
    const visible = rect.width >= 20 && rect.height >= 10 && rect.bottom >= 0 && rect.top <= window.innerHeight;
    if (!visible) continue;
    if (target.element && !target.element.contains(element)) continue;
    element.click();
    clickState?.set(text, { itemCount, at: Date.now() });
    return true;
  }
  return false;
}

/**
 * Marketplace result grids often virtualise their cards: scrolling replaces
 * old DOM nodes with new ones. Collect every visible window and merge by URL so
 * those replaced nodes are not lost.
 */
async function collectWithScrolling(collector, config) {
  const items = [];
  let latest = collector();
  const originalX = window.scrollX;
  const originalY = window.scrollY;
  let target = findScrollTarget(config);
  const originalElement = target.element;
  const originalElementTop = originalElement?.scrollTop || 0;
  let stableBottomRounds = 0;
  let lastHeight = 0;
  let loadMoreClicks = 0;
  const loadMoreState = new Map();
  let stalledRounds = 0;
  let scrollStalled = false;
  let duplicateCount = 0;
  const merge = (incoming) => {
    const merged = mergeCollectedItems(items, incoming);
    duplicateCount += merged.duplicates;
    return merged;
  };
  let rounds = 0;

  try {
    scrollToPosition(target, 0);
    await wait(320);
    latest = collector();
    merge(latest.items || []);
    // The result container may only become scrollable after hydration.
    target = findScrollTarget(config);

    for (; rounds < 80; rounds += 1) {
      latest = collector();
      merge(latest.items || []);

      const heightBeforeWait = scrollHeight(target);
      const viewport = scrollViewport(target);
      const currentY = scrollPosition(target);
      const atBottom = currentY + viewport >= heightBeforeWait - 20;

      if (atBottom) {
        // Give the sentinel time to append the next virtualised window, then
        // try a visible load-more control before deciding that this page ended.
        duplicateCount += await waitForDynamicItems(collector, items, 1300);
        const beforeSettled = items.length;
        const clickedMore = loadMoreClicks < 20
          && clickLoadMore(target, loadMoreState, items.length);
        if (clickedMore) {
          loadMoreClicks += 1;
          duplicateCount += await waitForDynamicItems(collector, items, 1700);
        }
        latest = collector();
        merge(latest.items || []);
        const refreshedTarget = findScrollTarget(config);
        if (refreshedTarget.element !== target.element) target = refreshedTarget;
        const heightAfterWait = scrollHeight(target);
        const addedAfterWait = items.length - beforeSettled;
        if (!addedAfterWait && !clickedMore && heightAfterWait <= Math.max(heightBeforeWait, lastHeight) + 12) stableBottomRounds += 1;
        else stableBottomRounds = 0;
        lastHeight = Math.max(lastHeight, heightAfterWait);
        if (stableBottomRounds >= 3) break;
        scrollToPosition(target, heightAfterWait);
      } else {
        stableBottomRounds = 0;
        const step = Math.max(Math.round(viewport * 0.78), 460);
        const requestedY = Math.min(heightBeforeWait, currentY + step);
        let movement = scrollToPosition(target, requestedY);
        await wait(90);

        // Some result grids replace their scroll container during hydration.
        // Refresh the target and retry when the requested position did not
        // actually change, otherwise the same virtual window repeats forever.
        if (requestedY > currentY + 2 && !movement.moved) {
          const refreshedTarget = findScrollTarget(config);
          if (refreshedTarget.element !== target.element) {
            target = refreshedTarget;
            movement = scrollToPosition(target, Math.min(scrollHeight(target), currentY + step));
            await wait(90);
          }
        }

        const actualY = scrollPosition(target);
        if (requestedY > currentY + 2 && actualY <= currentY + 2) {
          stalledRounds += 1;
          if (stalledRounds >= 3) {
            scrollStalled = true;
            break;
          }
        } else {
          stalledRounds = 0;
        }
        duplicateCount += await waitForDynamicItems(collector, items, 1000);
      }
    }
  } finally {
    window.scrollTo(originalX, originalY);
    if (originalElement) originalElement.scrollTop = originalElementTop;
    if (target.element && target.element !== originalElement) target.element.scrollTop = 0;
  }

  const uniqueCollectedItems = uniqueItems(items);
  duplicateCount += items.length - uniqueCollectedItems.length;
  const result = {
    ...(latest || {}),
    items: uniqueCollectedItems,
    cardCount: Math.max(latest?.cardCount || 0, uniqueCollectedItems.length),
    scrollRounds: rounds + 1,
    scrollComplete: rounds < 80 && !scrollStalled,
    scrollStalled,
    loadMoreClicks,
    duplicateCount
  };
  result.diagnostics = {
    ...(latest?.diagnostics || {}),
    collectedItemCount: items.length,
    scrollRounds: result.scrollRounds,
    scrollComplete: result.scrollComplete,
    scrollStalled,
    loadMoreClicks,
    duplicateCount
  };
  return result;
}

async function collectFirstPage() {
  const marketplace = marketplaceForLocation();
  if (!marketplace) return { ok: false, error: "暂不支持该平台" };
  if (marketplace.priceOnly) {
    return collectWithScrolling(() => collectGenericNow(marketplace), marketplace);
  }
  // eBay also hydrates and virtualises result cards while scrolling.
  return collectWithScrolling(collectNow, marketplace);
}

function detailTextFromDocument(document) {
  const selectors = [
    "meta[name='description']",
    "#viTabs_0_is",
    "#desc_div",
    ".x-item-description",
    "[data-testid*='DESCRIPTION']"
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = selector.startsWith("meta")
      ? element?.getAttribute("content")
      : element?.textContent;
    const text = normalizeText(value).replace(/\\s+/g, " ");
    if (text.length >= 20) return text.slice(0, 600);
  }
  const jsonLd = [...document.querySelectorAll("script[type='application/ld+json']")];
  for (const script of jsonLd) {
    try {
      const payload = JSON.parse(script.textContent || "{}");
      const candidates = Array.isArray(payload) ? payload : [payload];
      const product = candidates.find((entry) => entry?.description);
      const text = normalizeText(product?.description).replace(/\\s+/g, " ");
      if (text.length >= 20) return text.slice(0, 600);
    } catch {}
  }
  return "";
}

async function fetchDetail(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    if (!response.ok) return "";
    const html = await response.text();
    return detailTextFromDocument(new DOMParser().parseFromString(html, "text/html"));
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDetails(urls) {
  const details = {};
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= urls.length) return;
      details[urls[index]] = await fetchDetail(urls[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
  return details;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "fetch-ebay-details") {
    fetchDetails(Array.isArray(message.urls) ? message.urls.slice(0, 12) : [])
      .then((details) => sendResponse({ ok: true, details }))
      .catch(() => sendResponse({ ok: false, details: {} }));
    return true;
  }
  if (message?.type !== "collect-ebay-page-v2" && message?.type !== "collect-marketplace-page") return undefined;
  collectFirstPage().then(sendResponse);
  return true;
});
