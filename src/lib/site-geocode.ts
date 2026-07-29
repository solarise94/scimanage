/**
 * 高德地图 Web 服务 API 封装（site 定位用）。
 *
 * 与腾讯版（src/lib/crm/geocode.ts）的关键差异：
 *  - status 字段：高德 `"1"` 成功 / `"0"` 失败（与腾讯 `0` 成功相反，别搞反）
 *  - location 格式：`"经度,纬度"`（经度在前），解析时 split 逗号 [0]=lng [1]=lat
 *  - 空字段：高德常返回 `[]`（空数组）而非空串，统一用 strOrNull 归一为 null
 *
 * Key 从 process.env.AMAP_WEB_KEY 读取。
 * 不做 API 端限速（serverless 模块状态不跨请求持久，令牌桶无效）；限速只在
 * 批量回填脚本里用 await sleep() 串行化。
 */

const AMAP_BASE = "https://restapi.amap.com/v3";

export interface SiteGeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  poiName: string | null;
  source: "POI_SEARCH" | "GEOCODE";
  raw: string;
}

export interface ReGeoPoi {
  name: string;
  address: string;
  distance: number;
  category: string;
}

export interface ReGeocodeResult {
  formattedAddress: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  pois: ReGeoPoi[];
  raw: string;
}

export interface SuggestItem {
  name: string;
  district: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

function getKey(): string | null {
  return process.env.AMAP_WEB_KEY || null;
}

/** 高德 location "经度,纬度" → { lat, lng }；非法/空返回 null */
function parseLocation(loc: unknown): { lat: number; lng: number } | null {
  if (typeof loc !== "string" || !loc.includes(",")) return null;
  const [lngStr, latStr] = loc.split(",");
  const lng = parseFloat(lngStr);
  const lat = parseFloat(latStr);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
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
 * 地名 → 坐标。先 POI 搜索（/place/text）取首条，失败回退地理编码（/geocode/geo）。
 */
export async function geocodeSite(
  siteName: string,
  city?: string,
): Promise<{ error?: string; result?: SiteGeocodeResult }> {
  const key = getKey();
  if (!key) return { error: "高德地图 Key 未配置" };
  const name = siteName?.trim();
  if (!name) return { error: "院区名称为空" };

  // 1. POI 搜索优先
  const poiParams = new URLSearchParams({ key, keywords: name, offset: "1", page: "1", extensions: "all" });
  if (city?.trim()) poiParams.set("city", city.trim());
  try {
    const res = await fetch(`${AMAP_BASE}/place/text?${poiParams.toString()}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === "1" && Array.isArray(data.pois) && data.pois.length > 0) {
      const p = data.pois[0] as Record<string, unknown>;
      const loc = parseLocation(p.location);
      if (loc) {
        return {
          result: {
            lat: loc.lat,
            lng: loc.lng,
            formattedAddress: strOrNull(p.address) ?? strOrNull(p.name),
            province: strOrNull(p.pname),
            city: strOrNull(p.cityname),
            district: strOrNull(p.adname),
            poiName: strOrNull(p.name),
            source: "POI_SEARCH",
            raw: JSON.stringify(data),
          },
        };
      }
    }
  } catch {
    /* fall through to geocode */
  }

  // 2. 回退地理编码
  const geoParams = new URLSearchParams({ key, address: name });
  if (city?.trim()) geoParams.set("city", city.trim());
  try {
    const res = await fetch(`${AMAP_BASE}/geocode/geo?${geoParams.toString()}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === "1" && Array.isArray(data.geocodes) && data.geocodes.length > 0) {
      const g = data.geocodes[0] as Record<string, unknown>;
      const loc = parseLocation(g.location);
      if (loc) {
        return {
          result: {
            lat: loc.lat,
            lng: loc.lng,
            formattedAddress: strOrNull(g.formatted_address),
            province: strOrNull(g.province),
            city: strOrNull(g.city),
            district: strOrNull(g.district),
            poiName: null,
            source: "GEOCODE",
            raw: JSON.stringify(data),
          },
        };
      }
    }
    return { error: "未找到匹配的地点" };
  } catch {
    return { error: "高德地理编码请求失败" };
  }
}

/**
 * 坐标 → 地址（/geocode/regeo）。地图选点后回填。
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<{ error?: string; result?: ReGeocodeResult }> {
  const key = getKey();
  if (!key) return { error: "高德地图 Key 未配置" };

  const params = new URLSearchParams({
    key,
    location: `${lng},${lat}`, // 高德：经度在前
    extensions: "all",
    radius: "1000",
  });

  let data: Record<string, unknown>;
  try {
    const res = await fetch(`${AMAP_BASE}/geocode/regeo?${params.toString()}`);
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: "高德逆地理编码请求失败" };
  }

  if (data.status !== "1" || !data.regeocode) {
    return { error: `逆地理编码失败: ${strOrNull(data.info) ?? String(data.status)}` };
  }

  const r = data.regeocode as Record<string, unknown>;
  const comp = (r.addressComponent || {}) as Record<string, unknown>;
  const pois: ReGeoPoi[] = (Array.isArray(r.pois) ? (r.pois as Array<Record<string, unknown>>) : []).map((p) => ({
    name: strOrNull(p.name) ?? "",
    address: strOrNull(p.address) ?? "",
    distance: numOrZero(p.distance),
    category: strOrNull(p.type) ?? "",
  }));

  return {
    result: {
      formattedAddress: strOrNull(r.formatted_address),
      province: strOrNull(comp.province),
      city: strOrNull(comp.city),
      district: strOrNull(comp.district),
      pois,
      raw: JSON.stringify(data),
    },
  };
}

/**
 * 输入提示（/assistant/inputtips）。前端搜索框联想。
 * 没有坐标的提示项（location 为空）仍返回，lat/lng 置 null，由调用方决定是否过滤。
 */
export async function suggestSites(
  keyword: string,
  city?: string,
): Promise<{ error?: string; results?: SuggestItem[] }> {
  const key = getKey();
  if (!key) return { error: "高德地图 Key 未配置" };
  const kw = keyword?.trim();
  if (!kw) return { results: [] };

  const params = new URLSearchParams({ key, keywords: kw, datatype: "poi" });
  if (city?.trim()) params.set("city", city.trim());

  let data: Record<string, unknown>;
  try {
    const res = await fetch(`${AMAP_BASE}/assistant/inputtips?${params.toString()}`);
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: "高德输入提示请求失败" };
  }

  if (data.status !== "1") {
    return { error: `输入提示失败: ${strOrNull(data.info) ?? String(data.status)}` };
  }

  const tips = Array.isArray(data.tips) ? (data.tips as Array<Record<string, unknown>>) : [];
  const results: SuggestItem[] = tips
    .map((t) => {
      const loc = parseLocation(t.location);
      return {
        name: strOrNull(t.name) ?? "",
        district: strOrNull(t.district),
        address: strOrNull(t.address),
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
      };
    })
    .filter((t) => t.name);

  return { results };
}
