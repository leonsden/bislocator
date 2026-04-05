function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function slugifyRealm(realm) {
  return String(realm || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeSlot(slot) {
  const raw = (
    slot?.type ||
    slot?.name ||
    slot?.key?.href?.split("/").pop() ||
    ""
  )
    .toString()
    .trim()
    .toUpperCase();

  const map = {
    HEAD: "Head",
    NECK: "Neck",
    SHOULDER: "Shoulders",
    BACK: "Cloak",
    CHEST: "Chest",
    WRIST: "Wrist",
    HANDS: "Gloves",
    WAIST: "Belt",
    LEGS: "Legs",
    FEET: "Boots",
    FINGER_1: "Ring",
    FINGER_2: "Ring",
    TRINKET_1: "Trinket",
    TRINKET_2: "Trinket",
    MAIN_HAND: "Weapon",
    TWOHANDS: "Weapon",
    RANGED: "Weapon",
  };

  return map[raw] || raw || "Unknown";
}

function normalizeEquippedItems(apiData) {
  const equipped = Array.isArray(apiData?.equipped_items) ? apiData.equipped_items : [];

  return equipped
    .map((entry) => {
      const itemId = entry?.item?.id ?? null;
      const itemName = entry?.name ?? entry?.item?.name ?? null;
      const slot = normalizeSlot(entry?.slot);
      const level = entry?.level?.value ?? entry?.item_level?.value ?? null;

      return {
        slot,
        itemId,
        name: itemName,
        itemLevel: level,
        slotType: entry?.slot?.type ?? null,
      };
    })
    .filter((item) => item.itemId && item.slot !== "Unknown");
}

async function getAccessToken(region, clientId, clientSecret) {
  const tokenUrl = `https://${region}.battle.net/oauth/token`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (!data?.access_token) {
    throw new Error("Token response did not include an access token.");
  }

  return data.access_token;
}

async function getCharacterEquipment(region, realmSlug, characterName, accessToken) {
  const namespace = `profile-${region}`;
  const locale = region === "eu" ? "en_GB" : "en_US";
  const url = new URL(
    `https://${region}.api.blizzard.com/profile/wow/character/${realmSlug}/${characterName}/equipment`
  );

  url.searchParams.set("namespace", namespace);
  url.searchParams.set("locale", locale);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 404) {
    throw new Error("Character not found. Double-check region, realm, and character name.");
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Character request failed (${response.status}): ${text}`);
  }

  return await response.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed." });
  }

  const clientId = process.env.BLIZZARD_CLIENT_ID;
  const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return json(500, {
      error: "Missing BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET in Netlify environment variables.",
    });
  }

  const params = event.queryStringParameters || {};
  const region = String(params.region || "us").trim().toLowerCase();
  const realm = String(params.realm || "").trim();
  const name = String(params.name || "").trim();

  if (!realm || !name) {
    return json(400, { error: "Missing required query parameters: realm and name." });
  }

  if (!["us", "eu", "kr", "tw"].includes(region)) {
    return json(400, { error: "Unsupported region. Use us, eu, kr, or tw." });
  }

  try {
    const realmSlug = slugifyRealm(realm);
    const characterName = normalizeName(name);
    const accessToken = await getAccessToken(region, clientId, clientSecret);
    const raw = await getCharacterEquipment(region, realmSlug, characterName, accessToken);
    const equipped = normalizeEquippedItems(raw);

    return json(200, {
      character: {
        region,
        realm: raw?.character?.realm?.name || realm,
        realmSlug,
        name: raw?.character?.name || name,
        level: raw?.character?.level ?? null,
        className: raw?.character?.playable_class?.name ?? null,
        activeSpec: raw?.equipped_item_sets?.[0]?.name ?? null,
      },
      equipped,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return json(500, { error: error.message || "Unexpected server error." });
  }
};
