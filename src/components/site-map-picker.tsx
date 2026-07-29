"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MapPin, Search, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * SiteMapPicker (Task 1.13) — 院区地图选点
 *
 * 流程：输入院区名 → 调后端 /api/organization-sites/geocode (suggestSites) 联想 →
 * 选中 → geocode 取坐标 → 高德 JS API 渲染地图 + 可拖拽标点微调 →
 * 保存到 site 的 lat/lng（PATCH /api/organization-sites/[siteId]）。
 *
 * 高德 JS API 用 <script> 标签动态加载（避免 @amap/amap-jsapi-loader 这个两年未更新
 * 的包对 React 19 / Next 16 的潜在冲突）。安全密钥经 window._AMapSecurityConfig 注入。
 * JS key 与安全密钥都是 NEXT_PUBLIC_（高德 JS API 设计为前端可见，配合域名白名单）。
 */

interface SuggestItem {
  name: string;
  district: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

interface SiteMapPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  siteName: string;
  initialLat?: number | null;
  initialLng?: number | null;
  /** 城市提示，缩小高德搜索范围（可选） */
  city?: string | null;
  /** 保存成功回调，返回最终坐标 */
  onSaved?: (loc: { lat: number; lng: number }) => void;
}

// 默认地图中心（上海），仅在没有任何坐标时用作兜底视图。
const DEFAULT_CENTER = { lat: 31.2304, lng: 121.4737 };

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

let amapLoadPromise: Promise<void> | null = null;

/** 客户端动态加载高德 JS API（仅一次）。 */
function loadAmap(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("无浏览器环境"));
  if (window.AMap) return Promise.resolve();
  if (amapLoadPromise) return amapLoadPromise;

  const key = process.env.NEXT_PUBLIC_AMAP_JS_KEY;
  if (!key) return Promise.reject(new Error("高德 JS Key 未配置（NEXT_PUBLIC_AMAP_JS_KEY）"));

  const sec = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;
  if (sec) window._AMapSecurityConfig = { securityJsCode: sec };

  amapLoadPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { amapLoadPromise = null; reject(new Error("高德 JS API 加载失败")); };
    document.head.appendChild(s);
  });
  return amapLoadPromise;
}

export function SiteMapPicker({
  open, onOpenChange, siteId, siteName, initialLat, initialLng, city, onSaved,
}: SiteMapPickerProps) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);

  const [keyword, setKeyword] = useState(siteName);
  const [suggestions, setSuggestions] = useState<SuggestItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [coord, setCoord] = useState<{ lat: number; lng: number } | null>(
    Number.isFinite(initialLat as number) && Number.isFinite(initialLng as number)
      ? { lat: initialLat as number, lng: initialLng as number }
      : null,
  );
  const [source, setSource] = useState<"MANUAL" | "POI_SEARCH" | "GEOCODE">("MANUAL");
  const [saving, setSaving] = useState(false);

  // 把标点放到 (lat,lng)：没有则创建（draggable），有则移动；地图随之 panTo。
  const placeMarker = useCallback((lat: number, lng: number) => {
    const AMap = window.AMap;
    const map = mapRef.current;
    if (!AMap || !map) return;
    const pos = [lng, lat]; // 高德：经度在前
    if (!markerRef.current) {
      markerRef.current = new AMap.Marker({ position: pos, draggable: true, cursor: "move" });
      map.add(markerRef.current);
      markerRef.current.on("dragend", () => {
        const p = markerRef.current.getPosition();
        // 拖拽即视为人工校准
        setSource("MANUAL");
        setCoord({ lat: p.getLat(), lng: p.getLng() });
      });
    } else {
      markerRef.current.setPosition(pos);
    }
    map.setZoomAndCenter(16, pos);
  }, []);

  // 初始化地图（对话框打开时）。组件由父级在每次打开时重新挂载（关闭即卸载，
  // mapPickerSite → null），所以初始 state 已是「加载中」，effect 内无需同步 setState；
  // 异步回调里的 setState 不受 set-state-in-effect 限制。清理函数销毁地图实例。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadAmap()
      .then(() => {
        if (cancelled) return;
        const AMap = window.AMap;
        const el = mapElRef.current;
        if (!AMap || !el) return;
        const center = coord ?? DEFAULT_CENTER;
        if (!mapRef.current) {
          mapRef.current = new AMap.Map(el, {
            zoom: coord ? 16 : 11,
            center: [center.lng, center.lat],
          });
          // 点击地图也可放置/移动标点
          mapRef.current.on("click", (e: any) => {
            const lat = e.lnglat.getLat();
            const lng = e.lnglat.getLng();
            setSource("MANUAL");
            setCoord({ lat, lng });
            placeMarker(lat, lng);
          });
        }
        if (coord) placeMarker(coord.lat, coord.lng);
        setMapLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setMapError(err.message);
        setMapLoading(false);
      });
    return () => {
      cancelled = true;
      if (mapRef.current) {
        try { mapRef.current.destroy(); } catch { /* ignore */ }
        mapRef.current = null;
        markerRef.current = null;
      }
    };
    // coord/placeMarker 故意不入依赖：仅在打开时初始化一次，后续选点用 placeMarker 命令式更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runSuggest = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    try {
      const res = await fetch("/api/organization-sites/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "suggest", keyword: kw, city: city || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "联想失败");
      setSuggestions(Array.isArray(data.results) ? data.results : []);
      if ((data.results || []).length === 0) toast.info("没有联想结果，可直接点击「定位」或在地图上点选");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "联想失败");
    } finally {
      setSearching(false);
    }
  }, [keyword, city]);

  // 直接对关键词做地理编码（联想无结果时的兜底）。
  const runGeocode = useCallback(async (kw: string) => {
    const q = kw.trim();
    if (!q) return;
    setSearching(true);
    try {
      const res = await fetch("/api/organization-sites/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "geocode", keyword: q, city: city || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "定位失败");
      const r = data.result;
      if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) throw new Error("未返回有效坐标");
      setSource(r.source === "POI_SEARCH" ? "POI_SEARCH" : "GEOCODE");
      setCoord({ lat: r.lat, lng: r.lng });
      placeMarker(r.lat, r.lng);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "定位失败");
    } finally {
      setSearching(false);
    }
  }, [city, placeMarker]);

  const pickSuggestion = useCallback(async (item: SuggestItem) => {
    if (Number.isFinite(item.lat as number) && Number.isFinite(item.lng as number)) {
      setSource("POI_SEARCH");
      setCoord({ lat: item.lat as number, lng: item.lng as number });
      placeMarker(item.lat as number, item.lng as number);
    } else {
      // 联想项无坐标 → 用其名称走地理编码补坐标
      await runGeocode(item.name);
    }
  }, [placeMarker, runGeocode]);

  const handleSave = useCallback(async () => {
    if (!coord) { toast.error("请先选点"); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/organization-sites/${siteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: coord.lat, lng: coord.lng, geocodeSource: source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存定位失败");
      toast.success("院区定位已保存");
      onSaved?.(coord);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存定位失败");
    } finally {
      setSaving(false);
    }
  }, [coord, siteId, source, onSaved, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>院区地图选点 · {siteName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">搜索地点（院区名 / 地址）</Label>
            <div className="flex gap-2">
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runSuggest(); } }}
                placeholder="如：复旦大学枫林校区"
                className="flex-1"
              />
              <Button type="button" variant="outline" size="sm" disabled={searching || !keyword.trim()} onClick={runSuggest}>
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                <span className="ml-1">联想</span>
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={searching || !keyword.trim()} onClick={() => runGeocode(keyword)}>
                <MapPin className="h-3.5 w-3.5" />
                <span className="ml-1">定位</span>
              </Button>
            </div>
          </div>

          {suggestions.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-md border divide-y">
              {suggestions.map((s, i) => (
                <button
                  key={`${s.name}-${i}`}
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60"
                  onClick={() => pickSuggestion(s)}
                >
                  <span className="font-medium">{s.name}</span>
                  {(s.district || s.address) && (
                    <span className="text-xs text-muted-foreground ml-2">
                      {[s.district, s.address].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  {!Number.isFinite(s.lat as number) && <span className="text-[10px] text-amber-600 ml-2">需定位</span>}
                </button>
              ))}
            </div>
          )}

          <div className="relative h-72 w-full overflow-hidden rounded-md border bg-muted/30">
            <div ref={mapElRef} className="h-full w-full" />
            {mapLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />加载地图...
              </div>
            )}
            {mapError && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-sm text-red-600 px-4 text-center">
                {mapError}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {coord
                ? `坐标：${coord.lng.toFixed(6)}, ${coord.lat.toFixed(6)}（${source === "MANUAL" ? "人工" : source === "POI_SEARCH" ? "POI" : "地理编码"}）`
                : "尚未选点 — 联想/定位或直接点击地图"}
            </span>
            <Button size="sm" disabled={!coord || saving} onClick={handleSave}>
              {saving ? "保存中..." : "保存定位"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
