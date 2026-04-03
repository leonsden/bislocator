const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const BIS_PATH = path.join(DATA_DIR, "bm-hunter-bis.json");
const CACHE_PATH = path.join(DATA_DIR, "item-source-cache.json");
const DEBUG_PATH = path.join(DATA_DIR, "item-source-debug.json");

const USER_AGENT =
  "Mozilla/5.0 (compatible; bislocator/1.0; +https://github.com/leonsden/bislocator)";

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`Failed to read JSON from ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xml,text/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return await res.text();
}

function decodeHtml(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(str) {
  if (!str) return str;
  return decodeHtml(str.replace(/<[^>]*>/g, " "));
}

function normalizeWhitespace(str) {
  if (!str) return str;
  return str.replace(/\s+/g, " ").trim();
}

function cleanDropText(value) {
  if (value == null) return null;

  let text = String(value);
  text = stripTags(text);
  text = normalizeWhitespace(text);

  // Remove trailing wowhead item URLs accidentally captured
  text = text.replace(/\s*>\s*https?:\/\/www\.wowhead\.com\/item=.*$/i, "");
  text = text.replace(/\s*https?:\/\/\S+$/i, "");

  // Remove CDATA/markup leftovers
  text = text.replace(/\]\]+$/g, "");
  text = text.replace(/\]+$/g, "");

  // Remove drop chance suffixes
  text = text.replace(/\s*Drop Chance:\s*[\d.]+%\s*$/i, "");

  // Remove generic trailing separators
  text = text.replace(/\s*>\s*$/g, "");
  text = text.replace(/\s*[:|-]\s*$/g, "");

  text = normalizeWhitespace(text);

  return text || null;
}

function inferSourceType(source) {
  const s = (source || "").toLowerCase();

  if (s.includes("tier")) return "tier";

  if (
    s.includes("leatherworking") ||
    s.includes("blacksmithing") ||
    s.includes("tailoring") ||
    s.includes("jewelcrafting") ||
    s.includes("engineering") ||
    s.includes("inscription") ||
    s.includes("alchemy") ||
    s.includes("craft")
  ) {
    return "crafted";
  }

  return null;
}

function isLikelyInstanceName(name) {
  if (!name) return false;
  return /caverns|academy|skyreach|triumvirate|xenas|falls|leatherworking|tier/i.test(name);
}

function normalizeEntry(entry, item = null) {
  if (!entry) return entry;

  entry.method = entry.method || null;
  entry.sourceType =
    entry.sourceType ||
    (item ? item.sourceType || inferSourceType(item.source) : null);
  entry.instance = cleanDropText(entry.instance) || (item ? item.source || null : null);
  entry.boss = cleanDropText(entry.boss);
  entry.dropSource = cleanDropText(entry.dropSource);
  entry.dropSourceUrl = entry.dropSourceUrl || (item ? item.sourceUrl || null : null);
  entry.itemUrl =
    entry.itemUrl || (item ? `https://www.wowhead.com/item=${item.itemId}` : null);

  // Fallback: for boss-guide style entries like "Belo'ren"
  if (!entry.boss && item) {
    const fallbackSource = cleanDropText(item.source);
    if (
      fallbackSource &&
      !isLikelyInstanceName(fallbackSource) &&
      (item.sourceType === "raid" || item.sourceType === "dungeon")
    ) {
      entry.boss = fallbackSource;
      entry.dropSource = fallbackSource;
    }
  }

  return entry;
}

function isCacheComplete(entry, item) {
  if (!entry) return false;
  if (!entry.itemUrl) return false;

  const sourceType = item.sourceType || inferSourceType(item.source) || entry.sourceType;

  if (sourceType === "tier" || sourceType === "crafted") {
    return true;
  }

  return Boolean(entry.boss || entry.dropSource || entry.instance);
}

function tryMatch(text, regexes) {
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match) return match;
  }
  return null;
}

function extractBossFromText(text) {
  const cleaned = normalizeWhitespace(stripTags(text));
  if (!cleaned) return null;

  const patterns = [
    /Dropped by:\s*([^|]+?)(?:\s+in\s+[^|]+)?$/i,
    /Drop:\s*([^|]+?)(?:\s+in\s+[^|]+)?$/i,
    /Source:\s*([^|]+?)(?:\s+in\s+[^|]+)?$/i,
    /Boss:\s*([^|]+)$/i,
  ];

  const match = tryMatch(cleaned, patterns);
  if (!match) return null;

  return cleanDropText(match[1]);
}

function extractInstanceFromText(text) {
  const cleaned = normalizeWhitespace(stripTags(text));
  if (!cleaned) return null;

  const patterns = [
    /(?:Dropped by|Drop|Source):\s*[^|]+?\s+in\s+([^|]+)$/i,
    /Zone:\s*([^|]+)$/i,
    /Dungeon:\s*([^|]+)$/i,
    /Raid:\s*([^|]+)$/i,
    /Instance:\s*([^|]+)$/i,
  ];

  const match = tryMatch(cleaned, patterns);
  if (!match) return null;

  return cleanDropText(match[1]);
}

function extractFromXml(xml, item) {
  const result = {
    method: "wowhead-xml",
    sourceType: item.sourceType || inferSourceType(item.source),
    instance: item.source || null,
    boss: null,
    dropSource: null,
    dropSourceUrl: item.sourceUrl || null,
    itemUrl: `https://www.wowhead.com/item=${item.itemId}`,
  };

  if (result.sourceType === "tier" || result.sourceType === "crafted") {
    return normalizeEntry(result, item);
  }

  const lines = xml
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  for (const line of lines) {
    const boss = extractBossFromText(line);
    const instance = extractInstanceFromText(line);

    if (boss && !result.boss) {
      result.boss = boss;
      result.dropSource = boss;
    }

    if (instance && (!result.instance || result.instance === item.source)) {
      result.instance = instance;
    }
  }

  const cdataMatches = [...xml.matchAll(/<!\[CDATA\[(.*?)\]\]>/gis)].map((m) => m[1]);
  for (const block of cdataMatches) {
    const boss = extractBossFromText(block);
    const instance = extractInstanceFromText(block);

    if (boss && !result.boss) {
      result.boss = boss;
      result.dropSource = boss;
    }

    if (instance && (!result.instance || result.instance === item.source)) {
      result.instance = instance;
    }
  }

  return normalizeEntry(result, item);
}

async function enrichItem(item) {
  const itemUrl = `https://www.wowhead.com/item=${item.itemId}`;
  const xmlUrl = `${itemUrl}&xml`;

  try {
    const xml = await fetchText(xmlUrl);
    return extractFromXml(xml, item);
  } catch (err) {
    return normalizeEntry(
      {
        method: "fallback",
        sourceType: item.sourceType || inferSourceType(item.source),
        instance: item.source || null,
        boss: null,
        dropSource: null,
        dropSourceUrl: item.sourceUrl || null,
        itemUrl,
        error: err.message,
      },
      item
    );
  }
}

async function main() {
  ensureDataDir();

  const bis = readJson(BIS_PATH, null);
  if (!bis || !Array.isArray(bis.items)) {
    throw new Error("Could not read data/bm-hunter-bis.json or items array is missing.");
  }

  const cache = readJson(CACHE_PATH, {});
  const debug = [];

  for (const item of bis.items) {
    const cacheKey = String(item.itemId);

    if (cache[cacheKey]) {
      cache[cacheKey] = normalizeEntry(cache[cacheKey], item);
    }

    let enriched = cache[cacheKey];
    if (!isCacheComplete(enriched, item)) {
      enriched = await enrichItem(item);
      cache[cacheKey] = normalizeEntry(enriched, item);
      await sleep(500);
    } else {
      enriched = normalizeEntry(enriched, item);
      cache[cacheKey] = enriched;
    }

    item.boss = enriched.boss ?? null;
    item.dropSource = enriched.dropSource ?? null;
    item.itemUrl = enriched.itemUrl ?? `https://www.wowhead.com/item=${item.itemId}`;
    item.dropSourceUrl = enriched.dropSourceUrl ?? item.sourceUrl ?? null;
    item.enrichmentMethod = enriched.method ?? null;

    if (item.sourceType !== "tier" && item.sourceType !== "crafted" && !item.boss) {
      debug.push({
        itemId: item.itemId,
        name: item.name,
        slot: item.slot,
        source: item.source,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl || null,
        itemUrl: item.itemUrl,
        enrichmentMethod: item.enrichmentMethod,
      });
    }
  }

  if (!bis.source) bis.source = {};
  bis.source.enrichedAt = new Date().toISOString();

  writeJson(BIS_PATH, bis);
  writeJson(CACHE_PATH, cache);
  writeJson(DEBUG_PATH, debug);

  console.log(`Enriched ${bis.items.length} items.`);
  console.log(`Debug entries written: ${debug.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
