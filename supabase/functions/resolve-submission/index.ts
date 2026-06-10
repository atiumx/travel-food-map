// =============================================================
// resolve-submission Edge Function
// =============================================================
// POST /resolve-submission
// Body: { submission_id: string, raw_url: string, url_source: string }
// Auth: Authorization: Bearer <anon_jwt>  (owner check 留比 RPC layer 做)
//
// Flow:
//   1. Classify URL (google_maps / tabelog / openrice / unknown)
//   2. Dispatch to handler:
//      - google_maps: Google Places Text Search + Details
//      - tabelog:     Fetch HTML + parse OG meta + Tabelog schema.org JSON-LD
//      - openrice:    Fetch HTML + parse OG meta + JSON-LD (METADATA ONLY, NO rating)
//      - unknown:     Try Google Places Text Search with URL text
//   3. Call update_submission_resolved RPC with service_role key
//   4. Return resolved_data to caller
//
// Secrets required:
//   - SUPABASE_URL                (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   - GOOGLE_PLACES_API_KEY       (manual, you set this)
// =============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.7,en;q=0.3,zh-TW;q=0.5",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

type ResolvedData = {
  name?: string;
  lat?: number;
  lng?: number;
  address?: string;
  region?: string;
  category?: string;
  cuisine_group?: string;
  trip_area_slug?: string;
  google_place_id?: string;
  google_rating?: number;
  google_user_ratings_total?: number;
  google_url?: string;
  tabelog_url?: string;
  openrice_url?: string;
  openrice_poi_id?: string;
  phone?: string;
  opening_hours?: string;
  price_level?: string;
  _raw_source?: string;
  _resolver_notes?: string[];
};

// =============================================================
// Helpers
// =============================================================
function classifyUrl(url: string): "google_maps" | "tabelog" | "openrice" | "unknown" {
  const u = url.toLowerCase();
  if (/google\.[a-z\.]+\/maps/.test(u)) return "google_maps";
  if (u.includes("maps.app.goo.gl")) return "google_maps";
  if (u.includes("goo.gl/maps")) return "google_maps";
  if (u.includes("tabelog.com")) return "tabelog";
  if (u.includes("openrice.com")) return "openrice";
  return "unknown";
}

async function followRedirects(url: string, maxHops = 5): Promise<string> {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const r = await fetch(current, {
      method: "HEAD",
      redirect: "manual",
      headers: BROWSER_HEADERS,
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) break;
      current = loc.startsWith("http") ? loc : new URL(loc, current).href;
    } else {
      break;
    }
  }
  return current;
}

function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch (_e) {
      // skip malformed
    }
  }
  return out;
}

function extractMeta(html: string, prop: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const m = html.match(re);
  return m?.[1];
}

function extractMetaReverse(html: string, prop: string): string | undefined {
  // content="..." property="..." 順序
  const re = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
    "i",
  );
  const m = html.match(re);
  return m?.[1];
}

function metaOf(html: string, prop: string): string | undefined {
  return extractMeta(html, prop) ?? extractMetaReverse(html, prop);
}

// =============================================================
// Handler: Google Maps URL → Google Places API
// =============================================================
async function resolveGoogleMaps(url: string, notes: string[]): Promise<ResolvedData> {
  if (!GOOGLE_KEY) {
    throw new Error("GOOGLE_PLACES_API_KEY not configured");
  }

  // 跟住 redirect (maps.app.goo.gl / goo.gl/maps 短連結)
  const expanded = await followRedirects(url);
  notes.push(`expanded_url=${expanded}`);

  // Try extract place_id from URL: ...!1s0x...:0x.../...
  let placeId: string | undefined;
  let queryText: string | undefined;

  const cidMatch = expanded.match(/!1s([^!]+)/);
  if (cidMatch) {
    // cid is hex pair like "0x...:0x..."
    notes.push(`cid_hex=${cidMatch[1]}`);
  }

  // /place/NAME/@lat,lng,zoom
  const nameMatch = expanded.match(/\/place\/([^/@]+)/);
  if (nameMatch) {
    queryText = decodeURIComponent(nameMatch[1].replace(/\+/g, " "));
    notes.push(`extracted_name=${queryText}`);
  }

  // @lat,lng,zoom
  const coordMatch = expanded.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  let hintLat: number | undefined;
  let hintLng: number | undefined;
  if (coordMatch) {
    hintLat = parseFloat(coordMatch[1]);
    hintLng = parseFloat(coordMatch[2]);
    notes.push(`hint_coords=${hintLat},${hintLng}`);
  }

  if (!queryText) {
    // Last resort: use URL as text query
    queryText = expanded;
  }

  // Google Places Text Search (New API)
  const searchRes = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.primaryType,places.types,places.googleMapsUri,places.nationalPhoneNumber,places.regularOpeningHours.weekdayDescriptions,places.priceLevel,places.priceRange",
      },
      body: JSON.stringify({
        textQuery: queryText,
        ...(hintLat && hintLng
          ? {
              locationBias: {
                circle: {
                  center: { latitude: hintLat, longitude: hintLng },
                  radius: 500.0,
                },
              },
            }
          : {}),
      }),
    },
  );

  if (!searchRes.ok) {
    const errText = await searchRes.text();
    throw new Error(`google_places_text_search_failed: ${searchRes.status} ${errText.slice(0, 200)}`);
  }

  const data = await searchRes.json();
  const place = data.places?.[0];
  if (!place) {
    throw new Error("google_places_no_results");
  }

  placeId = place.id;
  notes.push(`google_place_id=${placeId}`);

  // 推斷 trip_area (HK = hongkong, JP = kyushu / osaka 等留比 owner edit)
  let tripSlug: string | undefined;
  const addr = (place.formattedAddress ?? "").toLowerCase();
  if (addr.includes("hong kong") || addr.includes("香港")) {
    tripSlug = "hongkong";
  } else if (addr.includes("kyushu") || addr.includes("九州") || addr.includes("fukuoka") || addr.includes("福岡")) {
    tripSlug = "kyushu";
  } else if (addr.includes("osaka") || addr.includes("大阪")) {
    tripSlug = "osaka";
  } else if (addr.includes("taipei") || addr.includes("台北")) {
    tripSlug = "taipei";
  }

  // primaryType → cuisine_group 粗略 mapping
  let cuisineGroup = "other";
  const ptype = (place.primaryType ?? "").toLowerCase();
  const types = (place.types ?? []).map((t: string) => t.toLowerCase());
  if (ptype.includes("japanese") || types.includes("japanese_restaurant")) cuisineGroup = "japanese";
  else if (ptype.includes("chinese") || types.includes("chinese_restaurant")) cuisineGroup = "chinese";
  else if (ptype.includes("italian") || types.includes("italian_restaurant")) cuisineGroup = "italian";
  else if (ptype.includes("cafe") || types.includes("cafe")) cuisineGroup = "cafe";
  else if (ptype.includes("bar") || types.includes("bar")) cuisineGroup = "bar";
  else if (types.some((t: string) => t.includes("restaurant"))) cuisineGroup = "other";

  // price_level mapping (Google Places "PRICE_LEVEL_INEXPENSIVE" etc → "$" "$$" ...)
  let priceLevel: string | undefined;
  const pl = place.priceLevel as string | undefined;
  if (pl === "PRICE_LEVEL_INEXPENSIVE") priceLevel = "$";
  else if (pl === "PRICE_LEVEL_MODERATE") priceLevel = "$$";
  else if (pl === "PRICE_LEVEL_EXPENSIVE") priceLevel = "$$$";
  else if (pl === "PRICE_LEVEL_VERY_EXPENSIVE") priceLevel = "$$$$";

  return {
    name: place.displayName?.text ?? queryText,
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    address: place.formattedAddress,
    region: undefined, // owner 自己填
    category: "asian", // 默認, owner 可改
    cuisine_group: cuisineGroup,
    trip_area_slug: tripSlug,
    google_place_id: placeId,
    google_rating: place.rating,
    google_user_ratings_total: place.userRatingCount,
    google_url: place.googleMapsUri,
    phone: place.nationalPhoneNumber,
    opening_hours: place.regularOpeningHours?.weekdayDescriptions?.join("\n"),
    price_level: priceLevel,
    _raw_source: "google_places",
  };
}

// =============================================================
// Handler: Tabelog URL → Fetch HTML + JSON-LD
// =============================================================
async function resolveTabelog(url: string, notes: string[]): Promise<ResolvedData> {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`tabelog_fetch_failed: ${res.status}`);
  }
  const html = await res.text();
  notes.push(`tabelog_html_len=${html.length}`);

  const jsonLds = extractJsonLd(html);
  const restaurant = jsonLds.find((j) => {
    if (Array.isArray(j["@type"])) return j["@type"].includes("Restaurant");
    return j["@type"] === "Restaurant" || j["@type"] === "FoodEstablishment";
  });

  if (!restaurant) {
    notes.push("tabelog_no_jsonld_restaurant");
  }

  const name =
    restaurant?.name ??
    metaOf(html, "og:title")?.replace(/\s*-\s*食べログ.*$/i, "").trim();
  const addr =
    restaurant?.address?.streetAddress ??
    (typeof restaurant?.address === "string" ? restaurant.address : undefined);

  let lat: number | undefined;
  let lng: number | undefined;
  if (restaurant?.geo?.latitude && restaurant?.geo?.longitude) {
    lat = parseFloat(String(restaurant.geo.latitude));
    lng = parseFloat(String(restaurant.geo.longitude));
  } else {
    // Tabelog 有時把 coord 放 <meta property="place:location:latitude">
    const ml = metaOf(html, "place:location:latitude");
    const mg = metaOf(html, "place:location:longitude");
    if (ml && mg) {
      lat = parseFloat(ml);
      lng = parseFloat(mg);
    }
  }

  // trip_area: 從 URL path 判斷 fukuoka / osaka 等
  let tripSlug: string | undefined;
  if (/\/(fukuoka|kyushu|saga|nagasaki|kumamoto|oita|miyazaki|kagoshima|okinawa)/.test(url)) {
    tripSlug = "kyushu";
  } else if (/\/(osaka|kyoto|hyogo|nara|wakayama|shiga)/.test(url)) {
    tripSlug = "osaka";
  } else if (/\/(tokyo|kanagawa|chiba|saitama)/.test(url)) {
    tripSlug = undefined; // 唔喺 trip_area, owner 自己判斷
    notes.push("tabelog_tokyo_area_not_in_trip_areas");
  }

  return {
    name,
    lat,
    lng,
    address: addr,
    category: "asian",
    cuisine_group: "japanese",
    trip_area_slug: tripSlug,
    tabelog_url: url,
    _raw_source: "tabelog",
  };
}

// =============================================================
// Handler: OpenRice URL → Fetch HTML, metadata ONLY (no rating)
// =============================================================
async function resolveOpenRice(url: string, notes: string[]): Promise<ResolvedData> {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`openrice_fetch_failed: ${res.status}`);
  }
  const html = await res.text();
  notes.push(`openrice_html_len=${html.length}`);

  // poi_id from URL end: ...-r770198 or ...-r770198/  (digits at end after -r)
  const poiMatch = url.match(/-r(\d+)(?:\/|\?|$)/);
  const poiId = poiMatch?.[1];

  const jsonLds = extractJsonLd(html);
  const restaurant = jsonLds.find((j) => {
    if (Array.isArray(j["@type"])) return j["@type"].includes("Restaurant");
    return j["@type"] === "Restaurant" || j["@type"] === "FoodEstablishment";
  });

  const name =
    restaurant?.name ??
    metaOf(html, "og:title")?.replace(/\s*\(.*?\)\s*$/, "").replace(/\s*[-|]\s*OpenRice.*$/i, "").trim();
  const addr = restaurant?.address?.streetAddress ?? restaurant?.address;
  let lat: number | undefined;
  let lng: number | undefined;
  if (restaurant?.geo?.latitude && restaurant?.geo?.longitude) {
    lat = parseFloat(String(restaurant.geo.latitude));
    lng = parseFloat(String(restaurant.geo.longitude));
  }
  const phone = restaurant?.telephone;

  if (!lat || !lng) notes.push("openrice_no_coords_jsonld");
  if (!restaurant) notes.push("openrice_no_foodestablishment_jsonld");

  // Cuisine 從 servesCuisine array 推斷
  let cuisineGroup = "other";
  const serves = restaurant?.servesCuisine;
  if (Array.isArray(serves)) {
    const joined = serves.join(" ").toLowerCase();
    if (joined.includes("hong kong") || joined.includes("cantonese") || joined.includes("dim sum")) cuisineGroup = "chinese";
    else if (joined.includes("japanese") || joined.includes("sushi") || joined.includes("ramen")) cuisineGroup = "japanese";
    else if (joined.includes("italian") || joined.includes("pizza")) cuisineGroup = "italian";
    else if (joined.includes("cafe") || joined.includes("coffee")) cuisineGroup = "cafe";
  }

  // price_level from OpenRice priceRange ("$101-200" etc)
  let priceLevel: string | undefined;
  const pr = restaurant?.priceRange;
  if (typeof pr === "string") {
    if (/\$1-50\b/i.test(pr)) priceLevel = "$";
    else if (/\$51-100\b|\$101-200\b/i.test(pr)) priceLevel = "$$";
    else if (/\$201-400\b/i.test(pr)) priceLevel = "$$$";
    else if (/\$401|\$501|\$1001/i.test(pr)) priceLevel = "$$$$";
  }

  notes.push("openrice_rating_excluded_by_policy");

  // OpenRice policy: server side block 咗 Supabase Edge IP, 18K shell HTML 無 FoodEstablishment.
  // 永久標記 manual_fill_required, 提示前端 owner modal 自己填 name/coords/address.
  if (!name || !lat || !lng) {
    notes.push("manual_fill_required");
  }

  return {
    name,
    lat,
    lng,
    address: typeof addr === "string" ? addr : undefined,
    category: "asian",
    cuisine_group: cuisineGroup,
    trip_area_slug: "hongkong",
    openrice_url: url,
    openrice_poi_id: poiId,
    phone,
    price_level: priceLevel,
    _raw_source: "openrice",
  };
}

// =============================================================
// Main dispatcher
// =============================================================
async function resolve(rawUrl: string): Promise<ResolvedData> {
  const notes: string[] = [];
  const cls = classifyUrl(rawUrl);
  notes.push(`url_class=${cls}`);

  let result: ResolvedData;
  switch (cls) {
    case "google_maps":
      result = await resolveGoogleMaps(rawUrl, notes);
      break;
    case "tabelog":
      result = await resolveTabelog(rawUrl, notes);
      break;
    case "openrice":
      result = await resolveOpenRice(rawUrl, notes);
      break;
    case "unknown":
      throw new Error("url_unsupported_source");
  }
  result._resolver_notes = notes;
  return result;
}

// =============================================================
// Call update_submission_resolved RPC with service_role
// =============================================================
async function writeResolved(
  submissionId: string,
  resolved: ResolvedData | null,
  errorMessage: string | null,
): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/update_submission_resolved`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      p_submission_id: submissionId,
      p_resolved_data: resolved,
      p_error_message: errorMessage,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error(`update_submission_resolved_failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

// =============================================================
// HTTP handler
// =============================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: { submission_id?: string; raw_url?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const submissionId = body.submission_id;
  const rawUrl = body.raw_url;

  if (!submissionId || !rawUrl) {
    return new Response(
      JSON.stringify({ error: "missing_submission_id_or_raw_url" }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const resolved = await resolve(rawUrl);
    await writeResolved(submissionId, resolved, null);
    return new Response(
      JSON.stringify({ ok: true, resolved }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`resolve_failed: ${msg}`);
    await writeResolved(submissionId, null, msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
