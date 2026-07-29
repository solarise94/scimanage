"use client";

/**
 * AgentResourceSheet — mobile full-screen resource viewer.
 *
 * Mobile counterpart of the desktop AgentResourcePanel.  Renders the same
 * embedded View via AgentResourceRenderer; the container is a right-side
 * full-screen Sheet (100dvh, safe-area aware) rather than a bottom half-sheet
 * — customer detail's many Tabs/Dialogs don't fit a bottom sheet (docs §7).
 *
 * The chat underneath stays mounted while the Sheet is open, so scroll
 * position, draft and session state are preserved when the user closes it.
 */

import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { AgentResourceRequest } from "@/lib/agent-resources/types";
import type { AgentResourceNavigation } from "../use-agent-resource-navigation";
import { AgentResourceRenderer } from "./agent-resource-renderer";

function SheetHeaderBar({ navigation }: { navigation: AgentResourceNavigation }) {
  const { current, resolving, canBack, canForward, back, forward, reload, close, openFullPage } = navigation;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-2",
        // Safe-area top inset for notch / status bar.
        "pt-[max(0.5rem,env(safe-area-inset-top))]",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={back}
        disabled={!canBack}
        title="返回"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={forward}
        disabled={!canForward}
        title="前进"
      >
        <ArrowRight className="h-4 w-4" />
      </Button>
      <div className="min-w-0 flex-1 px-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {resolving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
          <span className="truncate">{current?.title ?? "资源"}</span>
        </div>
      </div>
      {current ? (
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={reload} title="刷新">
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => openFullPage()}
            title="在完整页面打开"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        </>
      ) : null}
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={close} title="关闭">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function AgentResourceSheet({ navigation }: { navigation: AgentResourceNavigation }) {
  const { state, current, reloadToken, openResource, openFullPage, close } = navigation;
  const onOpenResource = (request: AgentResourceRequest) => void openResource(request);
  const open = state.open && state.entries.length > 0;

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <SheetContent
        side="right"
        className={cn(
          "flex w-full flex-col gap-0 p-0",
          // Full-screen on mobile: 100dvh + dynamic island / safe area.
          "h-[100dvh] w-full max-w-none sm:max-w-md",
        )}
      >
        <SheetHeaderBar navigation={navigation} />
        <ScrollArea className="min-h-0 flex-1">
          {current ? (
            <AgentResourceRenderer
              location={current}
              mode="sheet"
              reloadToken={reloadToken}
              onOpenResource={onOpenResource}
              onOpenFullPage={openFullPage}
            />
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">
              资源已关闭
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
