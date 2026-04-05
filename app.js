const DATA_PATH = "./data/bm-hunter-bis.json";
const CHARACTER_API_PATH = "/.netlify/functions/character-gear";
const SAVED_CHARACTERS_KEY = "bislocator.savedCharacters";
const LAST_CHARACTER_KEY = "bislocator.lastCharacter";

const state = {
  rawData: null,
  filteredItems: [],
  character: null,
  ownedItemIds: new Set(),
};

const searchInput = document.getElementById("search-input");
const sourceTypeFilter = document.getElementById("source-type-filter");
const ownershipFilter = document.getElementById("ownership-filter");
const sortFilter = document.getElementById("sort-filter");
const itemsTableBody = document.getElementById("items-table-body");
const itemCount = document.getElementById("item-count");
const summaryStats = document.getElementById("summary-stats");
const priorityList = document.getElementById("priority-list");
const refreshButton = document.getElementById("refresh-data-btn");
const priorityTemplate = document.getElementById("priority-card-template");

const regionInput = document.getElementById("region-input");
const realmInput = document.getElementById("realm-input");
const nameInput = document.getElementById("name-input");
const savedCharactersSelect = document.getElementById("saved-characters-select");
const loadCharacterBtn = document.getElementById("load-character-btn");
const refreshCharacterBtn = document.getElementById("refresh-character-btn");
const saveCharacterBtn = document.getElementById("save-character-btn");
const deleteCharacterBtn = document.getElementById("delete-character-btn");
const characterStatus = document.getElementById("character-status");
const characterSummary = document.getElementById("character-summary");

function safeText(value) {
  return value ?? "—";
}

function getSavedCharacters() {
  try {
    const raw = localStorage.getItem(SAVED_CHARACTERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setSavedCharacters(value) {
  localStorage.setItem(SAVED_CHARACTERS_KEY, JSON.stringify(value));
}

function getCharacterKey(character) {
  return `${character.region}:${character.realm.toLowerCase()}:${character.name.toLowerCase()}`;
}

function populateSavedCharacters() {
  const saved = getSavedCharacters();
  savedCharactersSelect.innerHTML = `<option value="">Choose a saved character</option>`;

  saved.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = `${entry.name} · ${entry.realm} (${entry.region.toUpperCase()})`;
    savedCharactersSelect.appendChild(option);
  });

  const last = localStorage.getItem(LAST_CHARACTER_KEY);
  if (last) {
    savedCharactersSelect.value = last;
    applySavedCharacter(last);
  }
}

function applySavedCharacter(key) {
  const entry = getSavedCharacters().find((item) => item.key === key);
  if (!entry) return;

  regionInput.value = entry.region;
  realmInput.value = entry.realm;
  nameInput.value = entry.name;
}

function setStatus(message, variant = "muted") {
  characterStatus.className = `status-box ${variant}`;
  characterStatus.textContent = message;
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

function isOwned(item) {
  return state.ownedItemIds.has(item.itemId);
}

function getFilteredItems() {
  if (!state.rawData?.items) return [];

  const search = searchInput.value.trim().toLowerCase();
  const sourceType = sourceTypeFilter.value;
  const ownership = ownershipFilter.value;
  const sortBy = sortFilter.value;

  const filtered = state.rawData.items.filter((item) => {
    const matchesSourceType = sourceType === "all" || item.sourceType === sourceType;
    const owned = isOwned(item);
    const matchesOwnership =
      ownership === "all" ||
      (ownership === "owned" && owned) ||
      (ownership === "missing" && !owned);

    const haystack = [item.slot, item.name, item.source, item.boss, item.sourceType]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const matchesSearch = !search || haystack.includes(search);

    return matchesSourceType && matchesOwnership && matchesSearch;
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
  const ownedCount = state.rawData?.items?.filter((item) => isOwned(item)).length || 0;
  const missingCount = (state.rawData?.items?.length || 0) - ownedCount;

  const boxes = [
    { label: "Visible Items", value: items.length },
    { label: "Owned BiS", value: ownedCount },
    { label: "Missing BiS", value: missingCount },
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

function renderCharacterSummary() {
  if (!state.character) {
    characterSummary.innerHTML = "";
    return;
  }

  const equippedCount = state.character.equipped.length;
  const ownedCount = state.rawData?.items?.filter((item) => isOwned(item)).length || 0;

  const boxes = [
    { label: "Character", value: state.character.character.name },
    { label: "Realm", value: state.character.character.realm },
    { label: "Level", value: state.character.character.level ?? "—" },
    { label: "Equipped Slots", value: equippedCount },
    { label: "Owned BiS", value: ownedCount },
  ];

  characterSummary.innerHTML = boxes
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
        <td colspan="7" class="empty-state">No items matched the current filters.</td>
      </tr>
    `;
    return;
  }

  itemsTableBody.innerHTML = items
    .map((item) => {
      const owned = isOwned(item);
      return `
        <tr class="${owned ? "owned-row" : "missing-row"}">
          <td><span class="status-pill ${owned ? "owned-pill" : "missing-pill"}">${owned ? "Owned" : "Missing"}</span></td>
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
      `;
    })
    .join("");
}

function buildPriorityGroups(items) {
  const groups = new Map();

  for (const item of items.filter((entry) => !isOwned(entry))) {
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
    priorityList.innerHTML = `<p class="empty-state">Nothing left to target from the current filtered set.</p>`;
    return;
  }

  priorityList.innerHTML = "";

  for (const group of groups) {
    const fragment = priorityTemplate.content.cloneNode(true);
    fragment.querySelector(".priority-title").textContent = sourceLabel(group);
    fragment.querySelector(".priority-meta").textContent = `${group.sourceType} · ${group.items.length} missing BiS item${group.items.length === 1 ? "" : "s"}`;
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
  renderCharacterSummary();
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
        <td colspan="7" class="empty-state">${error.message}</td>
      </tr>
    `;
    priorityList.innerHTML = `<p class="empty-state">Could not load priority data.</p>`;
    summaryStats.innerHTML = "";
  }
}

async function loadCharacter() {
  const region = regionInput.value.trim().toLowerCase();
  const realm = realmInput.value.trim();
  const name = nameInput.value.trim();

  if (!realm || !name) {
    setStatus("Enter a realm and character name first.", "error");
    return;
  }

  setStatus("Loading character...", "muted");

  try {
    const url = new URL(CHARACTER_API_PATH, window.location.origin);
    url.searchParams.set("region", region);
    url.searchParams.set("realm", realm);
    url.searchParams.set("name", name);

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Character lookup failed (${response.status})`);
    }

    state.character = data;
    state.ownedItemIds = new Set((data.equipped || []).map((item) => item.itemId));
    setStatus(
      `Loaded ${data.character.name} from ${data.character.realm}. ${data.equipped.length} equipped slots found.`,
      "success"
    );
    render();
  } catch (error) {
    state.character = null;
    state.ownedItemIds = new Set();
    setStatus(error.message, "error");
    render();
  }
}

function saveCurrentCharacter() {
  const region = regionInput.value.trim().toLowerCase();
  const realm = realmInput.value.trim();
  const name = nameInput.value.trim();

  if (!realm || !name) {
    setStatus("Enter a realm and character name before saving.", "error");
    return;
  }

  const entry = {
    key: getCharacterKey({ region, realm, name }),
    region,
    realm,
    name,
  };

  const saved = getSavedCharacters().filter((item) => item.key !== entry.key);
  saved.unshift(entry);
  setSavedCharacters(saved.slice(0, 12));
  localStorage.setItem(LAST_CHARACTER_KEY, entry.key);
  populateSavedCharacters();
  savedCharactersSelect.value = entry.key;
  setStatus(`Saved ${name} on ${realm}.`, "success");
}

function deleteSavedCharacter() {
  const key = savedCharactersSelect.value || localStorage.getItem(LAST_CHARACTER_KEY);
  if (!key) {
    setStatus("Choose a saved character to delete.", "error");
    return;
  }

  const saved = getSavedCharacters().filter((item) => item.key !== key);
  setSavedCharacters(saved);

  if (localStorage.getItem(LAST_CHARACTER_KEY) === key) {
    localStorage.removeItem(LAST_CHARACTER_KEY);
  }

  populateSavedCharacters();
  setStatus("Saved character removed.", "success");
}

searchInput.addEventListener("input", render);
sourceTypeFilter.addEventListener("change", render);
ownershipFilter.addEventListener("change", render);
sortFilter.addEventListener("change", render);
refreshButton.addEventListener("click", loadData);
loadCharacterBtn.addEventListener("click", loadCharacter);
refreshCharacterBtn.addEventListener("click", loadCharacter);
saveCharacterBtn.addEventListener("click", saveCurrentCharacter);
deleteCharacterBtn.addEventListener("click", deleteSavedCharacter);
savedCharactersSelect.addEventListener("change", (event) => {
  if (!event.target.value) return;
  localStorage.setItem(LAST_CHARACTER_KEY, event.target.value);
  applySavedCharacter(event.target.value);
});

populateSavedCharacters();
loadData();
