#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BIS_PATH = path.join(DATA_DIR, 'bm-hunter-bis.json');
const CACHE_PATH = path.join(DATA_DIR, 'item-source-cache.json');
const DEBUG_PATH = path.join(DATA_DIR, 'item-source-debug.json');
const BASE_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (compatible; bislocator/0.3; +https://github.com/leonsden/bislocator)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7'
};

const KNOWN_DUNGEONS = [
  'maisara caverns',
  'seat of the triumvirate',
  'skyreach',
  'nexus point xenas',
  'nexus-point xenas',
  "algeth'ar academy"
];

const KNOWN_NON_BOSS_SOURCES = new Set([
  'midnight falls',
  'lightblinded vanguard',
  'the voidspire',
  'march on quel’danas',
  "march on quel'danas",
  'march on quel-danas',
  'tier set',
  'leatherworking'
]);

async function main() {
  const bis = JSON.parse(await fs.readFile(BIS_PATH, 'utf8'));
  const cache = await loadJson(CACHE_PATH, {});
  const debug = {
    generatedAt: new Date().toISOString(),
    attempted: [],
    failures: []
  };

  for (const item of bis.items) {
    if (!item.itemId) continue;

    const cached = cache[item.itemId];
    if (isCacheUsable(cached, item)) {
      applyEnrichment(item, cached);
      continue;
    }

    try {
      const enrichment = await fetchItemSourceDetails(item);
      cache[item.itemId] = enrichment;
      applyEnrichment(item, enrichment);
      debug.attempted.push({ itemId: item.itemId, name: item.name, method: enrichment.method });
      console.log(`Enriched ${item.itemId} ${item.name} via ${enrichment.method}`);
    } catch (error) {
      const failure = {
        itemId: item.itemId,
        name: item.name,
        source: item.source,
        sourceType: item.sourceType,
        error: error.message
      };
      debug.failures.push(failure);
      console.warn(`Could not enrich ${item.itemId} ${item.name}: ${error.message}`);

      const fallback = buildFallbackEnrichment(item, 'fallback');
      cache[item.itemId] = fallback;
      applyEnrichment(item, fallback);
    }

    await sleep(400);
  }

  bis.source = {
    ...bis.source,
    enrichedAt: new Date().toISOString()
  };

  await fs.writeFile(BIS_PATH, JSON.stringify(bis, null, 2) + '\n', 'utf8');
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  await fs.writeFile(DEBUG_PATH, JSON.stringify(debug, null, 2) + '\n', 'utf8');
  console.log(`Updated ${BIS_PATH}`);
}

async function fetchItemSourceDetails(item) {
  const endpoints = [
    {
      method: 'wowhead-xml',
      url: `https://www.wowhead.com/item=${item.itemId}&xml`
    },
    {
      method: 'wowhead-tooltip',
      url: `https://www.wowhead.com/tooltip/item/${item.itemId}`
    },
    {
      method: 'wowhead-html',
      url: `https://www.wowhead.com/item=${item.itemId}`
    },
    {
      method: 'wowdb',
      url: `https://wowdb.com/items/${item.itemId}`
    },
    {
      method: 'wowdb-ptr',
      url: `https://ptr.wowdb.com/items/${item.itemId}`
    }
  ];

  for (const endpoint of endpoints) {
    try {
      const text = await fetchText(endpoint.url);
      const parsed = parseSourceFromText(text, item, endpoint.method);
      if (parsed && hasMeaningfulEnrichment(parsed, item)) {
        return parsed;
      }
    } catch (error) {
      // Try the next endpoint quietly.
    }
  }

  throw new Error('No boss or improved drop source could be parsed from configured endpoints.');
}

function parseSourceFromText(text, item, method) {
  const rawText = decodeHtml(stripTags(String(text || '')))
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();

  const result = buildFallbackEnrichment(item, method);
  const hint = item.source || null;

  const combinedPatterns = [
    /Dropped by\s+([^|.]+?)\s*-\s*([^|.]+?)(?:\.|\||$)/i,
    /Dropped by\s+([^|.]+?)\s+in\s+([^|.]+?)(?:\.|\||$)/i,
    /Dropped by:\s*([^|.]+?)\s*-\s*([^|.]+?)(?:\.|\||$)/i,
    /Drops? from\s+([^|.]+?)\s*-\s*([^|.]+?)(?:\.|\||$)/i
  ];

  for (const pattern of combinedPatterns) {
    const match = rawText.match(pattern);
    if (match) {
      const maybeBoss = tidy(match[1]);
      const maybeInstance = tidy(match[2]);
      if (looksLikeBossName(maybeBoss)) result.boss = maybeBoss;
      if (maybeInstance) result.instance = maybeInstance;
      result.dropSource = result.boss || maybeBoss || result.dropSource;
      return finalizeEnrichment(result, item);
    }
  }

  const bossPatterns = [
    /Dropped by:\s*([^|]+?)(?:Chance:|Drop Chance|Sell Price|Requires Level|Quick Facts|Screenshots|Related|$)/i,
    /Dropped by\s+([^|]+?)(?:Chance:|Drop Chance|Sell Price|Requires Level|Quick Facts|Screenshots|Related|$)/i,
    /Drops? from\s+([^|]+?)(?:Chance:|Drop Chance|Sell Price|Requires Level|Quick Facts|Screenshots|Related|$)/i,
    /Source:\s*([^|]+?)(?:Chance:|Drop Chance|Sell Price|Requires Level|Quick Facts|Screenshots|Related|$)/i
  ];

  for (const pattern of bossPatterns) {
    const match = rawText.match(pattern);
    if (!match) continue;

    const dropText = tidy(match[1]);
    if (!dropText) continue;

    const split = splitDropText(dropText, hint);
    if (split.boss && looksLikeBossName(split.boss)) result.boss = split.boss;
    if (split.instance) result.instance = split.instance;
    result.dropSource = split.dropSource || dropText;
    return finalizeEnrichment(result, item);
  }

  const instancePatterns = [
    /Zone:\s*([^|]+?)(?:Item Level|Requires Level|Sell Price|Quick Facts|Dropped by|Screenshots|Related|$)/i,
    /Location:\s*([^|]+?)(?:Item Level|Requires Level|Sell Price|Quick Facts|Dropped by|Screenshots|Related|$)/i,
    /Instance:\s*([^|]+?)(?:Item Level|Requires Level|Sell Price|Quick Facts|Dropped by|Screenshots|Related|$)/i
  ];

  for (const pattern of instancePatterns) {
    const match = rawText.match(pattern);
    if (match) {
      const instance = tidy(match[1]);
      if (instance) {
        result.instance = instance;
        break;
      }
    }
  }

  const exactHintIndex = hint ? rawText.toLowerCase().indexOf(hint.toLowerCase()) : -1;
  if (!result.boss && exactHintIndex !== -1 && result.sourceType === 'dungeon') {
    const windowStart = Math.max(0, exactHintIndex - 180);
    const nearby = rawText.slice(windowStart, exactHintIndex + hint.length + 60);
    const nearbyBoss = nearby.match(/([A-Z][A-Za-z'’:-]+(?:\s+[A-Z][A-Za-z'’:-]+){0,4})\s*-\s*/);
    if (nearbyBoss && looksLikeBossName(nearbyBoss[1])) {
      result.boss = tidy(nearbyBoss[1]);
      result.dropSource = result.boss;
    }
  }

  return finalizeEnrichment(result, item);
}

function finalizeEnrichment(result, item) {
  result.instance = normalizeInstanceName(result.instance || item.source);

  if (!result.boss && isLikelyBoss(item.source)) {
    result.boss = item.source;
  }

  if (!result.dropSource && result.boss) {
    result.dropSource = result.boss;
  }

  result.itemUrl = `https://www.wowhead.com/item=${item.itemId}`;
  result.sourceType = classifySource(result.instance || item.source);

  if (!hasMeaningfulEnrichment(result, item)) {
    return null;
  }

  return result;
}

function buildFallbackEnrichment(item, method) {
  return {
    method,
    sourceType: classifySource(item.source),
    instance: item.source || null,
    boss: isLikelyBoss(item.source) ? item.source : null,
    dropSource: isLikelyBoss(item.source) ? item.source : null,
    dropSourceUrl: item.sourceUrl || null,
    itemUrl: `https://www.wowhead.com/item=${item.itemId}`
  };
}

function hasMeaningfulEnrichment(result, item) {
  if (!result) return false;

  if (result.boss) return true;

  const normalizedItemSource = normalizeForCompare(item.source);
  const normalizedInstance = normalizeForCompare(result.instance);
  if (normalizedInstance && normalizedItemSource && normalizedInstance !== normalizedItemSource) {
    return true;
  }

  if (result.dropSource && normalizeForCompare(result.dropSource) !== normalizedItemSource) {
    return true;
  }

  return result.sourceType === 'tier' || result.sourceType === 'crafted';
}

function isCacheUsable(cached, item) {
  if (!cached) return false;
  if (cached.boss) return true;
  if (cached.sourceType === 'tier' || cached.sourceType === 'crafted') return true;

  const normalizedInstance = normalizeForCompare(cached.instance);
  const normalizedSource = normalizeForCompare(item.source);
  if (normalizedInstance && normalizedSource && normalizedInstance !== normalizedSource) {
    return true;
  }

  return false;
}

function splitDropText(dropText, instanceHint) {
  const cleaned = tidy(dropText);
  const out = {
    boss: null,
    instance: null,
    dropSource: cleaned || null
  };

  if (!cleaned) return out;

  const dashParts = cleaned.split(/\s+-\s+/);
  if (dashParts.length >= 2) {
    const first = tidy(dashParts[0]);
    const second = tidy(dashParts.slice(1).join(' - '));

    if (looksLikeBossName(first)) out.boss = first;
    if (second) out.instance = second;
    return out;
  }

  if (instanceHint) {
    const hintIndex = cleaned.toLowerCase().indexOf(instanceHint.toLowerCase());
    if (hintIndex > 0) {
      const bossPart = tidy(cleaned.slice(0, hintIndex));
      if (looksLikeBossName(bossPart)) out.boss = bossPart.replace(/[,:-]\s*$/, '');
      out.instance = instanceHint;
      return out;
    }
  }

  if (looksLikeBossName(cleaned)) {
    out.boss = cleaned;
  }

  return out;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: BASE_HEADERS, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function applyEnrichment(item, enrichment) {
  item.source = enrichment.instance || item.source;
  item.sourceType = enrichment.sourceType || item.sourceType;
  item.boss = enrichment.boss || null;
  item.dropSource = enrichment.dropSource || null;
  item.itemUrl = enrichment.itemUrl || `https://www.wowhead.com/item=${item.itemId}`;
  item.dropSourceUrl = enrichment.dropSourceUrl || null;
  item.enrichmentMethod = enrichment.method || null;
}

function classifySource(sourceName) {
  const normalized = normalizeForCompare(sourceName);
  if (!normalized) return 'unknown';
  if (normalized.includes('tier')) return 'tier';
  if (
    normalized.includes('leatherworking') ||
    normalized.includes('blacksmithing') ||
    normalized.includes('tailoring') ||
    normalized.includes('jewelcrafting') ||
    normalized.includes('inscription') ||
    normalized.includes('alchemy') ||
    normalized.includes('engineering')
  ) {
    return 'crafted';
  }
  if (KNOWN_DUNGEONS.includes(normalized)) return 'dungeon';
  return 'raid';
}

function isLikelyBoss(name) {
  const normalized = normalizeForCompare(name);
  if (!normalized) return false;
  if (KNOWN_NON_BOSS_SOURCES.has(normalized)) return false;
  if (KNOWN_DUNGEONS.includes(normalized)) return false;
  return true;
}

function looksLikeBossName(name) {
  const value = tidy(name);
  if (!isLikelyBoss(value)) return false;
  if (/^(raid|dungeon|instance|zone|location)$/i.test(value)) return false;
  return /[A-Za-z]/.test(value);
}

function normalizeInstanceName(name) {
  const value = tidy(name);
  if (!value) return value;
  if (/^nexus[- ]point xenas$/i.test(value)) return 'Nexus Point Xenas';
  return value;
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidy(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-:–—\s]+/, '')
    .replace(/[|]+$/, '')
    .replace(/[\]\[{}]+/g, ' ')
    .trim();
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
