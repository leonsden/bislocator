#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const WOWHEAD_URL =
  'https://www.wowhead.com/guide/classes/hunter/beast-mastery/bis-gear';

async function main() {
  const html = await loadHtml();
  const pageTitle = matchOne(html, /<title>([^<]+)<\/title>/i)?.trim() ?? null;
  const updatedAt = matchOne(html, /"dateModified":"([^"]+)"/);

  const guideMarkup = extractGuideBodyMarkup(html);
  const itemMap = extractItemMap(html);
  const items = extractBisItems(guideMarkup, itemMap);

  if (items.length === 0) {
    throw new Error('No BiS rows were parsed from the Wowhead guide source.');
  }

  const output = {
    spec: 'beast-mastery-hunter',
    source: {
      site: 'Wowhead',
      url: WOWHEAD_URL,
      title: pageTitle,
      updatedAt,
      scrapedAt: new Date().toISOString()
    },
    items
  };

  const outDir = path.resolve(process.cwd(), 'data');
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'bm-hunter-bis.json');
  await fs.writeFile(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`Wrote ${items.length} BiS rows to ${outFile}`);
}

async function loadHtml() {
  const localPath = process.env.WOWHEAD_HTML_PATH;
  if (localPath) {
    return fs.readFile(path.resolve(localPath), 'utf8');
  }

  const response = await fetch(WOWHEAD_URL, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (compatible; bislocator/0.1; +https://github.com/leonsden/bislocator)'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Wowhead page: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function extractGuideBodyMarkup(html) {
  const guideBodyIndex = html.lastIndexOf('"guide-body"');
  if (guideBodyIndex === -1) {
    throw new Error('Could not find guide-body renderer call in the page source.');
  }

  const callIndex = html.lastIndexOf('WH.markup.printHtml(', guideBodyIndex);
  if (callIndex === -1) {
    throw new Error('Could not find the guide-body WH.markup.printHtml call in the page source.');
  }

  const openParenIndex = html.indexOf('(', callIndex);
  if (openParenIndex === -1 || openParenIndex > guideBodyIndex) {
    throw new Error('Could not locate the argument list for WH.markup.printHtml.');
  }

  const firstQuoteIndex = findFirstQuote(html, openParenIndex + 1, guideBodyIndex);
  if (firstQuoteIndex === -1) {
    throw new Error('Could not locate the guide markup string.');
  }

  const { value } = parseJsStringLiteral(html, firstQuoteIndex);
  return value;
}

function extractItemMap(html) {
  const marker = 'WH.Gatherer.addData(3, 1,';
  const start = html.indexOf(marker);
  if (start === -1) {
    throw new Error('Could not find embedded item data in the page source.');
  }

  const jsonStart = html.indexOf('{', start);
  if (jsonStart === -1) {
    throw new Error('Could not find the item data JSON object.');
  }

  const jsonEnd = findMatchingBrace(html, jsonStart);
  const jsonText = html.slice(jsonStart, jsonEnd + 1);
  const rawMap = JSON.parse(jsonText);

  const itemMap = new Map();
  for (const [id, item] of Object.entries(rawMap)) {
    itemMap.set(Number(id), {
      id: Number(id),
      name: item.name_enus ?? null,
      icon: item.icon ?? null,
      quality: item.quality ?? null
    });
  }

  return itemMap;
}

function extractBisItems(markup, itemMap) {
  const titleIndex = markup.indexOf('Best in Slot Gear for Beast Mastery Hunter');
  if (titleIndex === -1) {
    throw new Error('Could not find the Beast Mastery Hunter BiS section title in the guide markup.');
  }

  const tableStart = markup.indexOf('[table', titleIndex);
  const tableEnd = markup.indexOf('[/table]', tableStart);
  if (tableStart === -1 || tableEnd === -1) {
    throw new Error('Could not find the Beast Mastery Hunter BiS table in the guide markup.');
  }

  const tableChunk = markup.slice(tableStart, tableEnd);
  const rows = [...tableChunk.matchAll(/\[tr\]([\s\S]*?)\[\/tr\]/gi)].map((match) => match[1]);

  const items = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/\[td\]([\s\S]*?)\[\/td\]/gi)].map((match) => match[1].trim());
    if (cells.length !== 3) {
      continue;
    }

    const slotText = stripMarkup(cells[0]);
    if (!slotText || /^slot$/i.test(slotText)) {
      continue;
    }

    const itemRef = parseItemCell(cells[1], itemMap);
    const source = parseSourceCell(cells[2]);

    items.push({
      slot: slotText,
      itemId: itemRef.itemId,
      name: itemRef.name,
      source: source.name,
      sourceType: source.type,
      sourceGuideId: source.guideId,
      sourceUrl: source.url
    });
  }

  return items;
}

function parseItemCell(cell, itemMap) {
  const itemMatch = cell.match(/\[item=(\d+)(?:[^\]]*)\]/i);
  if (itemMatch) {
    const itemId = Number(itemMatch[1]);
    const mapped = itemMap.get(itemId);
    return {
      itemId,
      name: mapped?.name || stripMarkup(cell) || null
    };
  }

  return {
    itemId: null,
    name: stripMarkup(cell) || null
  };
}

function parseSourceCell(cell) {
  const skillUrlMatch = cell.match(/\[url=(?:\/)?skill=(\d+)\/([^\]]+)\]([\s\S]*?)\[\/url\]/i);
  if (skillUrlMatch) {
    const skillSlug = skillUrlMatch[2];
    return {
      name: stripMarkup(skillUrlMatch[3]),
      type: 'crafted',
      guideId: null,
      url: `https://www.wowhead.com/skill=${skillUrlMatch[1]}/${skillSlug}`
    };
  }

  const skillMatch = cell.match(/\[skill=(\d+)\]/i);
  if (skillMatch) {
    return {
      name: skillNameFromId(Number(skillMatch[1])),
      type: 'crafted',
      guideId: null,
      url: null
    };
  }

  const guideMatch = cell.match(/\[url guide=(\d+)\]([\s\S]*?)\[\/url\]/i);
  if (guideMatch) {
    return {
      name: stripMarkup(guideMatch[2]),
      type: classifySource(stripMarkup(guideMatch[2])),
      guideId: Number(guideMatch[1]),
      url: null
    };
  }

  const plain = stripMarkup(cell);
  return {
    name: plain,
    type: classifySource(plain),
    guideId: null,
    url: null
  };
}

function classifySource(sourceName) {
  const normalized = (sourceName || '').toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('tier set')) return 'tier';
  if (normalized.includes('leatherworking')) return 'crafted';
  if (
    [
      'algeth',
      'academy',
      'caverns',
      'skyreach',
      'seat of the triumvirate',
      'nexus point',
      'dungeon'
    ].some((term) => normalized.includes(term))
  ) {
    return 'dungeon';
  }
  return 'raid';
}

function skillNameFromId(skillId) {
  const map = {
    165: 'Leatherworking'
  };
  return map[skillId] ?? `Profession ${skillId}`;
}

function stripMarkup(input) {
  return input
    .replace(/\[icon[^\]]*\]/gi, '')
    .replace(/\[\/icon\]/gi, '')
    .replace(/\[(?:b|\/b|i|\/i|u|\/u|small|\/small|tooltip[^\]]*|\/tooltip|color[^\]]*|\/color)\]/gi, '')
    .replace(/\[url[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[item[^\]]*\]([\s\S]*?)\[\/item\]/gi, '$1')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsStringLiteral(text, quoteIndex) {
  const quote = text[quoteIndex];
  if (quote !== '"' && quote !== "'") {
    throw new Error('Expected a JavaScript string literal.');
  }

  let i = quoteIndex + 1;
  let raw = quote;

  while (i < text.length) {
    const char = text[i];
    raw += char;

    if (char === '\\') {
      i += 1;
      if (i >= text.length) {
        break;
      }
      raw += text[i];
    } else if (char === quote) {
      return {
        value: JSON.parse(raw),
        endIndex: i
      };
    }

    i += 1;
  }

  throw new Error('Unterminated JavaScript string literal.');
}

function findFirstQuote(text, start, end) {
  for (let i = start; i < end; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'") {
      return i;
    }
  }
  return -1;
}

function findMatchingBrace(text, openBraceIndex) {
  let depth = 0;
  let inString = false;
  let stringQuote = '';

  for (let i = openBraceIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  throw new Error('Could not find the closing brace for the item data object.');
}

function matchOne(text, regex) {
  return text.match(regex)?.[1] ?? null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
