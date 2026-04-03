const DATA_PATH = "../data/bm-hunter-bis.json";

const state = {
  rawData: null,
  filteredItems: [],
};

const searchInput = document.getElementById("search-input");
const sourceTypeFilter = document.getElementById("source-type-filter");
const sortFilter = document.getElementById("sort-filter");
const itemsTableBody = document.getElementById("items-table-body");
const itemCount = document.getElementById("item-count");
const summaryStats = document.getElementById("summary-stats");
const priorityList = document.getElementById("priority-list");
const refreshButton = document.getElementById("refresh-data-btn");
const priorityTemplate = document.getElementById("priority-card-template");

function safeText(value) {
  return value ?? "—";
}

function scoreGroup(group) {
  let score = 0;

  for (const item of group.items) {
    if (item.slot === "Weapon") score += 5;
    else if (item.slot === "Trinket") score += 4;
    else if (item.sourceType === "raid") score += 3;
    else if (item.sourceType === "dungeon") score += 3;
    else if (item.sourceType === "crafted") score += 2;
    else if (item.sourceType === "tier") score += 2;
    else score += 1;
  }

  if (group.items.length > 1) {
    score += group.items.length;
  }

  return score;
}

function sourceLabel(item) {
  if (item.sourceType === "crafted") return `${item.source} Craft`;
  if (item.sourceType === "tier") return "Tier Set";
  return item.source;
}

function getFilteredItems() {
  if (!state.rawData?.items) return [];

  const search = searchInput.value.trim().toLowerCase();
  const sourceType = sourceTypeFilter.value;
  const sortBy = sortFilter.value;

  const filtered = state.rawData.items.filter((item) => {
    const matchesSourceType = sourceType === "all" || item.sourceType === sourceType;

    const haystack = [
      item.slot,
      item.name,
      item.source,
      item.boss,
      item.sourceType,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const matchesSearch = !search || haystack.includes(search);

    return matchesSourceType && matchesSearch;
  });

  filtered.sort((a, b) => {
    const av = (a[sortBy] || "").toString().toLowerCase();
    const bv = (b[sortBy] || "").toString().toLowerCase();
    return av.localeCompare(bv);
  });

  return filtered;
}

function renderStats(items) {
  const raidCount = items.filter((item) => item.sourceType === "raid").length;
  const dungeonCount = items.filter((item) => item.sourceType === "dungeon").length;
  const tierCount = items.filter((item) => item.sourceType === "tier").length;
  const craftedCount = items.filter((item) => item.sourceType === "crafted").length;

  const boxes = [
    { label: "Visible Items", value: items.length },
    { label: "Raid Pieces", value: raidCount },
    { label: "Dungeon Pieces", value: dungeonCount },
    { label: "Tier Pieces", value: tierCount },
    { label: "Crafted Pieces", value: craftedCount },
  ];

  summaryStats.innerHTML = boxes
    .map(
      (box) => `
        <div class="stat-box">
          <strong>${box.value}</strong>
          <span>${box.label}</span>
        </div>
      `
    )
    .join("");
}

function renderItems(items) {
  itemCount.textContent = `${items.length} items`;

  if (!items.length) {
    itemsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">No items matched the current filters.</td>
      </tr>
    `;
    return;
  }

  itemsTableBody.innerHTML = items
    .map(
      (item) => `
        <tr>
          <td>${safeText(item.slot)}</td>
          <td>${safeText(item.name)}</td>
          <td><span class="source-badge">${safeText(item.sourceType)}</span></td>
          <td>${safeText(sourceLabel(item))}</td>
          <td>${safeText(item.boss)}</td>
          <td>
            <div class="link-group">
              ${item.itemUrl ? `<a href="${item.itemUrl}" target="_blank" rel="noopener noreferrer">Item</a>` : ""}
              ${item.sourceUrl ? `<a href="${item.sourceUrl}" target="_blank" rel="noopener noreferrer">Source</a>` : ""}
            </div>
          </td>
        </tr>
      `
    )
    .join("");
}

function buildPriorityGroups(items) {
  const groups = new Map();

  for (const item of items) {
    const key = `${item.sourceType}:${item.source}`;

    if (!groups.has(key)) {
      groups.set(key, {
        source: item.source,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl || null,
        items: [],
      });
    }

    groups.get(key).items.push(item);
  }

  return Array.from(groups.values())
    .map((group) => ({ ...group, score: scoreGroup(group) }))
    .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
}

function renderPriority(items) {
  const groups = buildPriorityGroups(items);

  if (!groups.length) {
    priorityList.innerHTML = `<p class="empty-state">No content matched the current filters.</p>`;
    return;
  }

  priorityList.innerHTML = "";

  for (const group of groups) {
    const fragment = priorityTemplate.content.cloneNode(true);
    fragment.querySelector(".priority-title").textContent = sourceLabel(group);
    fragment.querySelector(".priority-meta").textContent = `${group.sourceType} · ${group.items.length} BiS item${group.items.length === 1 ? "" : "s"}`;
    fragment.querySelector(".priority-score").textContent = group.score;

    const list = fragment.querySelector(".priority-items");
    list.innerHTML = group.items
      .map((item) => {
        const bossPart = item.boss ? ` — ${item.boss}` : "";
        return `<li><strong>${item.slot}</strong>: ${item.name}${bossPart}</li>`;
      })
      .join("");

    priorityList.appendChild(fragment);
  }
}

function render() {
  const items = getFilteredItems();
  state.filteredItems = items;
  renderStats(items);
  renderItems(items);
  renderPriority(items);
}

async function loadData() {
  try {
    const response = await fetch(`${DATA_PATH}?t=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`Failed to load data: ${response.status}`);
    }

    state.rawData = await response.json();
    render();
  } catch (error) {
    itemsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">${error.message}</td>
      </tr>
    `;
    priorityList.innerHTML = `<p class="empty-state">Could not load priority data.</p>`;
    summaryStats.innerHTML = "";
  }
}

searchInput.addEventListener("input", render);
sourceTypeFilter.addEventListener("change", render);
sortFilter.addEventListener("change", render);
refreshButton.addEventListener("click", loadData);

loadData();
