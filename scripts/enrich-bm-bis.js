#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BIS_PATH = path.join(DATA_DIR, 'bm-hunter-bis.json');
const CACHE_PATH = path.join(DATA_DIR, 'item-source-cache.json');
const BASE_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (compatible; bislocator/0.2; +https://github.com/leonsden/bislocator)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function main() {
  const bis = JSON.parse(await fs.readFile(BIS_PATH, 'utf8'));
  const cache = await loadCache();

  for (const item of bis.items) {
    const cached = cache[item.itemId];
    if (cached) {
      applyEnrichment(item, cached);
      continue;
    }

    if (!item.itemId) continue;

    try {
      const enrichment = await fetchItemSourceDetails(item.itemId, item.source);
      cache[item.itemId] = enrichment;
      applyEnrichment(item, enrichment);
      console.log(`Enriched ${item.itemId} ${item.name}`);
    } catch (error) {
      console.warn(`Could not enrich ${item.itemId} ${item.name}: ${error.message}`);
    }

    await sleep(500);
  }

  bis.source = {
    ...bis.source,
    enrichedAt: new Date().toISOString()
  };

  await fs.writeFile(BIS_PATH, JSON.stringify(bis, null, 2) + '\n', 'utf8');
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  console.log(`Updated ${BIS_PATH}`);
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  } catch {
    return {};
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

async function fetchItemSourceDetails(itemId, existingSource) {
  const xmlUrl = `https://www.wowhead.com/item=${itemId}&xml`;
  const xmlText = await fetchText(xmlUrl);
  const xmlResult = parseSourceFromText(xmlText, existingSource, 'xml');
  if (xmlResult) return { ...xmlResult, itemUrl: `https://www.wowhead.com/item=${itemId}` };

  const htmlUrl = `https://www.wowhead.com/item=${itemId}`;
  const htmlText = await fetchText(htmlUrl);
  const htmlResult = parseSourceFromText(htmlText, existingSource, 'html');
  if (htmlResult) return { ...htmlResult, itemUrl: htmlUrl };

  throw new Error('No drop source could be parsed from Wowhead responses.');
}

async function fetchText(url) {
  const response = await fetch(url, { headers: BASE_HEADERS, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function parseSourceFromText(text, existingSource, method) {
  const cleaned = decodeHtml(stripTags(text)).replace(/\s+/g, ' ').trim();
  const result = {
    method,
    sourceType: classifySource(existingSource),
    instance: existingSource,
    boss: null,
    dropSource: null,
    dropSourceUrl: null
  };

  const instancePatterns = [
    /Zone:\s*([^|]+?)(?:Item Level|Requires Level|Sell Price|Dropped by:|$)/i,
    /Location:\s*([^|]+?)(?:Item Level|Requires Level|Sell Price|Dropped by:|$)/i,
    /Instance:\s*([^|]+?)(?:Item Level|Requires Level|Sell Price|Dropped by:|$)/i
  ];
  for (const pattern of instancePatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const instance = tidy(match[1]);
      if (instance) {
        result.instance = instance;
        break;
      }
    }
  }

  const dropPatterns = [
    /Dropped by:\s*([^|]+?)(?:Chance:|Sell Price|Requires Level|$)/i,
    /Dropped By\s*([^|]+?)(?:Chance:|Sell Price|Requires Level|$)/i,
    /Drop:\s*([^|]+?)(?:Chance:|Sell Price|Requires Level|$)/i
  ];
  for (const pattern of dropPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const dropText = tidy(match[1]);
      if (dropText) {
        result.dropSource = dropText;
        if (looksLikeBossName(dropText)) {
          result.boss = dropText;
        }
        break;
      }
    }
  }

  if (!result.boss && isLikelyBoss(existingSource)) {
    result.boss = existingSource;
  }

  if (!result.dropSource && result.boss) {
    result.dropSource = result.boss;
  }

  if (!result.instance && existingSource) {
    result.instance = existingSource;
  }

  if (!result.dropSource && !result.instance) {
    return null;
  }

  return result;
}

function classifySource(sourceName) {
  const normalized = (sourceName || '').toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('tier')) return 'tier';
  if (normalized.includes('leatherworking') || normalized.includes('blacksmithing') || normalized.includes('tailoring') || normalized.includes('jewelcrafting') || normalized.includes('inscription') || normalized.includes('alchemy') || normalized.includes('engineering')) return 'crafted';
  const dungeonNames = [
    'maisara caverns',
    'seat of the triumvirate',
    'skyreach',
    'nexus point xenas',
    "algeth'ar academy"
  ];
  if (dungeonNames.includes(normalized)) return 'dungeon';
  return 'raid';
}

function isLikelyBoss(name) {
  if (!name) return false;
  const normalized = name.toLowerCase().trim();
  const nonBoss = new Set([
    'midnight falls',
    'the voidspire',
    'march on quel’danas',
    'march on quel\'danas',
    'maisara caverns',
    'seat of the triumvirate',
    'skyreach',
    'nexus point xenas',
    "algeth'ar academy",
    'tier set',
    'leatherworking'
  ]);
  return !nonBoss.has(normalized);
}

function tidy(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-:–—\s]+/, '')
    .replace(/[|]+$/, '')
    .trim();
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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
