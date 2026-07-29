export interface PoiItem {
  name: string;
  address: string;
  distance: number;
  category: string;
}

export interface GeocodeResult {
  address: string;
  formattedAddress: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  pois: PoiItem[];
  raw: string;
}

// Higher score = more relevant POI
const POI_CATEGORY_PRIORITY: Record<string, number> = {
  "学校": 100, "大学": 100, "学院": 100,
  "医院": 90, "医疗": 90,
  "火车站": 80, "地铁站": 80, "汽车站": 80,
  "园区": 70, "产业园区": 70, "开发区": 70,
  "景点": 60, "公园": 60, "景区": 60, "旅游景点": 60,
  "政府": 50, "行政机关": 50,
};

function poiPriority(poi: PoiItem): number {
  const searchStr = `${poi.name} ${poi.category}`;
  for (const [key, score] of Object.entries(POI_CATEGORY_PRIORITY)) {
    if (searchStr.includes(key)) return score;
  }
  return 0;
}

function sortPois(pois: PoiItem[]): PoiItem[] {
  return [...pois].sort((a, b) => poiPriority(b) - poiPriority(a));
}

/** 高德空字段常为 []（空数组），统一归一：非空字符串原样，其余 null */
function strOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v;
  return null;
}

function numOrZero(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * 单次高德逆地理编码（/v3/geocode/regeo）。
 *
 * 高德与腾讯关键差异：
 *  - status 字段：高德 `"1"` 成功 / `"0"` 失败（与腾讯 `0` 成功相反）
 *  - location 参数：`"经度,纬度"`（经度在前）
 *  - 坐标系都是 GCJ-02，历史 lat/lng 数据无需转换
 */
async function fetchAmapRegeo(
  lat: number,
  lng: number,
  key: string,
  radius: number,
): Promise<{ error?: string; result?: GeocodeResult }> {
  const params = new URLSearchParams({
    key,
    location: `${lng},${lat}`, // 高德：经度在前
    extensions: "all",
    radius: String(radius),
  });
  const url = `https://restapi.amap.com/v3/geocode/regeo?${params.toString()}`;

  let data: Record<string, unknown>;
  try {
    const res = await fetch(url);
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: "Geocode request failed" };
  }

  if (data.status !== "1" || !data.regeocode) {
    return { error: `Geocode error: status=${String(data.status)}` };
  }

  const r = data.regeocode as Record<string, unknown>;
  const comp = (r.addressComponent || {}) as Record<string, unknown>;

  const pois: PoiItem[] = (Array.isArray(r.pois) ? (r.pois as Array<Record<string, unknown>>) : []).map((p) => ({
    name: strOrNull(p.name) ?? "",
    address: strOrNull(p.address) ?? "",
    distance: numOrZero(p.distance),
    category: strOrNull(p.type) ?? "",
  }));

  const formatted = strOrNull(r.formatted_address);

  return {
    result: {
      address: formatted ?? "",
      formattedAddress: formatted,
      province: strOrNull(comp.province),
      city: strOrNull(comp.city),
      district: strOrNull(comp.district),
      pois: sortPois(pois).slice(0, 5),
      raw: JSON.stringify(data),
    },
  };
}

const HIGH_PRIORITY_THRESHOLD = 60;

function hasHighPriorityPoi(pois: PoiItem[]): boolean {
  return pois.some((p) => poiPriority(p) >= HIGH_PRIORITY_THRESHOLD);
}

/**
 * 坐标 → 地址（逆地理编码）。已从腾讯迁移到高德。
 *
 * 对外签名保持不变：`{ error?, status?, result?: GeocodeResult }`，调用方
 * （maps/reverse-geocode、profiles/[id]/checkins）无需改动。`status` 字段保留在
 * 类型签名中以兼容旧调用方的判断分支，但高德路径不再返回腾讯式数字 status。
 */
export async function reverseGeocode(lat: number, lng: number): Promise<{ error?: string; status?: number; result?: GeocodeResult }> {
  const key = process.env.AMAP_WEB_KEY;
  if (!key) return { error: "地图 Key 未配置" };

  // First round: narrow radius (500m) to pin the immediate location
  const first = await fetchAmapRegeo(lat, lng, key, 500);
  if (first.error) return first;

  const firstPois = first.result?.pois ?? [];
  const hasHighPriority = hasHighPriorityPoi(firstPois);

  // If first round already has both an address and a high-priority POI, done
  if (first.result?.formattedAddress && hasHighPriority) return first;

  // Otherwise widen radius (高德 regeo radius 上限 3000m) to find landmarks
  const second = await fetchAmapRegeo(lat, lng, key, 3000);
  if (second.error || !second.result) return first;

  // Merge: keep first round's address, merge + dedup POIs
  const seenNames = new Set(firstPois.map((p) => p.name));
  const mergedPois = [...firstPois];
  for (const p of second.result.pois) {
    if (!seenNames.has(p.name)) {
      seenNames.add(p.name);
      mergedPois.push(p);
    }
  }

  return {
    result: {
      ...second.result,
      address: first.result?.address || second.result.address,
      formattedAddress: first.result?.formattedAddress || second.result.formattedAddress,
      pois: sortPois(mergedPois).slice(0, 5),
    },
  };
}
