"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { MapPin, RefreshCw, Check, X, AlertCircle, Loader2, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

interface GeoData {
  lat: number;
  lng: number;
  accuracy: number;
  capturedAt: string;
}

const MAX_LOCATION_AGE_MS = 5 * 60 * 1000;

/**
 * CRM checkin draft card.
 *
 * Interactive card for preparing and saving a visit checkin:
 * - Get current position (user gesture triggers geolocation)
 * - Re-locate
 * - Save checkin (PATCH proposal -> confirm -> execute)
 * - Cancel
 *
 * The "Save" button is only enabled when hasGeo is true (Phase 2).
 * Photos/voice (Phase 4) will extend this condition.
 */
export function CrmCheckinDraftCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onUpdateProposal,
  onCreateProposal,
  onCardDirtyChange,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const profileId = descriptor.props.profileId as string;
  const customerName = descriptor.props.customerName as string;
  const organization = descriptor.props.organization as string;
  const handlers = { onOpenResource, onApplyViewIntent };

  const [geo, setGeo] = useState<GeoData | null>(null);
  const [geoStatus, setGeoStatus] = useState<"idle" | "loading" | "error" | "denied">("idle");
  const [geoError, setGeoError] = useState<string>("");
  const [addressPreview, setAddressPreview] = useState<string | null>(null);
  const [addressStatus, setAddressStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [addressNote, setAddressNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [geoStale, setGeoStale] = useState(false);
  const locationRequestIdRef = useRef(0);
  const addressAbortRef = useRef<AbortController | null>(null);

  const isSaved = descriptor.state === "saved";
  const isTerminal = isSaved || descriptor.state === "cancelled";
  const hasGeo = geo != null && !geoStale;

  // Track unsaved state for dirty-card protection.
  // The registry wraps this with a stable cardId, so the card only reports
  // dirty=true/false.  The cleanup only unregisters THIS card.
  useEffect(() => {
    if (isTerminal) {
      onCardDirtyChange?.(false);
      return;
    }
    const dirty = hasGeo || addressNote.trim().length > 0;
    onCardDirtyChange?.(dirty);
    return () => onCardDirtyChange?.(false);
  }, [hasGeo, addressNote, isTerminal, onCardDirtyChange]);

  // Periodically check if geo data has expired
  useEffect(() => {
    if (!geo) return;
    const check = () => {
      setGeoStale(Date.now() - new Date(geo.capturedAt).getTime() > MAX_LOCATION_AGE_MS);
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [geo]);

  useEffect(() => () => {
    addressAbortRef.current?.abort();
  }, []);

  const previewAddress = useCallback(async (nextGeo: GeoData, requestId: number) => {
    addressAbortRef.current?.abort();
    const controller = new AbortController();
    addressAbortRef.current = controller;
    setAddressStatus("loading");
    try {
      const res = await fetch("/api/crm/maps/reverse-geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: nextGeo.lat, lng: nextGeo.lng }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({})) as {
        result?: { formattedAddress?: string | null; address?: string | null };
      };
      if (requestId !== locationRequestIdRef.current) return;
      const address = data.result?.formattedAddress || data.result?.address || "";
      if (!res.ok || !address.trim()) throw new Error("地址解析失败");
      setAddressPreview(address.trim());
      setAddressStatus("success");
    } catch {
      if (controller.signal.aborted || requestId !== locationRequestIdRef.current) return;
      setAddressPreview(null);
      setAddressStatus("error");
    }
  }, []);

  const handleGetLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setGeoStatus("error");
      setGeoError("设备不支持定位");
      return;
    }

    const requestId = ++locationRequestIdRef.current;
    addressAbortRef.current?.abort();
    // 重新定位时清空旧坐标，避免失败后仍显示/保存上次位置。
    setGeo(null);
    setGeoStale(false);
    setGeoStatus("loading");
    setGeoError("");
    setAddressPreview(null);
    setAddressStatus("idle");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextGeo = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          capturedAt: new Date().toISOString(),
        };
        if (requestId !== locationRequestIdRef.current) return;
        setGeo(nextGeo);
        setGeoStatus("idle");
        void previewAddress(nextGeo, requestId);
      },
      (error) => {
        if (requestId !== locationRequestIdRef.current) return;
        setGeo(null);
        if (error.code === error.PERMISSION_DENIED) {
          setGeoStatus("denied");
          setGeoError("未获得定位权限，可重新授权，或改为记录普通拜访");
        } else if (error.code === error.TIMEOUT) {
          setGeoStatus("error");
          setGeoError("定位超时，请重试");
        } else {
          setGeoStatus("error");
          setGeoError("定位失败，请重试");
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }, [previewAddress]);

  const [createdProposalId, setCreatedProposalId] = useState<string | null>(null);

  async function handleSave() {
    if (!hasGeo || !geo) return;
    setSaving(true);
    try {
      const checkinInput = {
        profileId,
        lat: geo.lat,
        lng: geo.lng,
        accuracy: geo.accuracy,
        capturedAt: geo.capturedAt,
        addressNote: addressNote.trim() || undefined,
      };

      if (proposal) {
        // Proposal already exists (from Pi confirm path or legacy) - PATCH + confirm
        await onUpdateProposal(proposal.id, checkinInput);
        await onConfirmProposal(proposal.id);
      } else if (onCreateProposal) {
        // No proposal yet (from prepare_visit_checkin safe action) - create one
        const newProposal = await onCreateProposal("crm.create_visit_checkin", checkinInput);
        if (newProposal) {
          setCreatedProposalId(newProposal.id);
          // Immediately confirm - the user's "Save" click IS the confirmation
          await onConfirmProposal(newProposal.id);
        }
      }
    } catch {
      // Error handled by parent (toast)
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (proposal) {
      onRejectProposal(proposal.id);
    } else if (createdProposalId) {
      onRejectProposal(createdProposalId);
    }
    // If no proposal was created, cancel is just a local no-op
  }

  if (isSaved) {
    // Show result state
    const address = descriptor.props.addressSnapshot as string | undefined;
    return (
      <CardShell title="签到完成" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0">
            {profileId ? (
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1 text-left text-sm font-medium hover:underline focus-visible:outline-none"
                onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
              >
                <span className="truncate">{customerName}</span>
                <span className="shrink-0 font-normal text-muted-foreground">· 签到成功</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              </button>
            ) : (
              <div className="text-sm font-medium">{customerName} · 签到成功</div>
            )}
            {address ? <div className="text-[11px] text-muted-foreground">{address}</div> : null}
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title={`现场签到：${customerName}`}
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!hasGeo || geoStatus === "loading" || saving || proposalBusyId === proposal?.id}
            onClick={handleSave}
          >
            {saving || proposalBusyId === proposal?.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            保存签到
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={handleCancel}
          >
            <X className="h-4 w-4" />
            取消
          </Button>
        </div>
      }
    >
      {/* Customer info */}
      {profileId ? (
        <button
          type="button"
          className="mb-3 flex w-full items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium">{customerName}</div>
            {organization ? <div className="text-[11px] text-muted-foreground">{organization}</div> : null}
          </div>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        </button>
      ) : (
        <div className="mb-3 rounded-lg bg-muted/30 px-3 py-2">
          <div className="text-sm font-medium">{customerName}</div>
          {organization ? <div className="text-[11px] text-muted-foreground">{organization}</div> : null}
        </div>
      )}

      {/* Location status */}
      {geoStatus === "loading" ? (
        <div className="flex items-center gap-2 rounded-lg border border-sky-200/80 bg-sky-50/80 px-3 py-2.5 text-xs text-sky-950">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在获取定位…
        </div>
      ) : hasGeo && geo ? (
        <div className="rounded-lg border border-emerald-200/80 bg-emerald-50/80 px-3 py-2.5 text-xs text-emerald-950">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            <span className="font-medium">已获取定位</span>
          </div>
          <div className="mt-1 space-y-0.5 opacity-80">
            {addressStatus === "success" && addressPreview ? (
              <div className="break-words font-medium opacity-100">{addressPreview}</div>
            ) : addressStatus === "loading" ? (
              <div>正在解析地址…</div>
            ) : addressStatus === "error" ? (
              <div>定位已获取，地址解析暂时失败</div>
            ) : null}
            <div>精度：±{Math.round(geo.accuracy)}米</div>
            <div>采集时间：{new Date(geo.capturedAt).toLocaleTimeString("zh-CN")}</div>
          </div>
        </div>
      ) : geoStatus === "denied" || geoStatus === "error" ? (
        <div className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-3 py-2.5 text-xs text-rose-950">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span className="font-medium">定位失败</span>
          </div>
          <div className="mt-1 opacity-80">{geoError}</div>
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-3 flex gap-2">
        {geoStatus === "loading" ? (
          <Button size="sm" variant="outline" className="flex-1" disabled>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            定位中…
          </Button>
        ) : hasGeo ? (
          <Button size="sm" variant="outline" className="flex-1" onClick={handleGetLocation}>
            <RefreshCw className="h-3.5 w-3.5" />
            重新定位
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="flex-1" onClick={handleGetLocation}>
            <MapPin className="h-3.5 w-3.5" />
            获取当前位置
          </Button>
        )}
      </div>

      {/* Address note */}
      {hasGeo ? (
        <div className="mt-3">
          <Textarea
            value={addressNote}
            onChange={(e) => setAddressNote(e.target.value)}
            placeholder="可选：补充地址备注"
            rows={2}
            className="resize-none text-sm"
          />
        </div>
      ) : null}

      {/* No-location hint */}
      {!hasGeo && geoStatus !== "loading" ? (
        <div className="mt-2 text-center text-[11px] text-muted-foreground">
          需要获取定位后才能保存签到
        </div>
      ) : null}
    </CardShell>
  );
}
