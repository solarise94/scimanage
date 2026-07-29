"use client";

/**
 * AgentResourcePanel — desktop right-hand resource viewer.
 *
 * The desktop counterpart of the mobile AgentResourceSheet.  Both render the
 * same embedded View via AgentResourceRenderer; only the container chrome
 * differs.
 *
 * Driven entirely by `AgentResourceNavigation` state (user clicks) — never by
 * tool/proposal events.  Per docs §6.3 the toolbar offers back / forward /
 * title / reload / open-full-page / collapse / close, and the empty state
 * prompts the user to open a resource from the conversation (never claims
 * results will auto-appear).
 */

import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AgentResourceRequest } from "@/lib/agent-resources/types";
import type { AgentResourceNavigation } from "../use-agent-resource-navigation";
import { AgentResourceRenderer } from "./agent-resource-renderer";

function PanelHeader({
  navigation,
  onToggleCollapse,
}: {
  navigation: AgentResourceNavigation;
  onToggleCollapse: () => void;
}) {
  const { current, resolving, canBack, canForward, back, forward, reload, close, openFullPage } = navigation;
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={back}
        disabled={!canBack}
        title="返回"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
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
          <span className="truncate">{current?.title ?? "资源面板"}</span>
        </div>
      </div>
      {current ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={reload}
            title="刷新"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => openFullPage()}
            title="在完整页面打开"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={close}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onToggleCollapse}
        title="收起面板"
      >
        <PanelRightClose className="h-4 w-4" />
      </Button>
    </div>
  );
}

function CollapsedRail({ onToggleCollapse }: { onToggleCollapse: () => void }) {
  return (
    <div className="flex h-full w-12 flex-col items-center rounded-xl bg-background py-4 shadow-sm">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onToggleCollapse}
        title="展开资源面板"
      >
        <PanelRightOpen className="h-4 w-4" />
      </Button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
        <Sparkles className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">资源面板</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          在对话中点击客户、订单、项目等资源链接，即可在此处查看。
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
        <Search className="h-3.5 w-3.5" />
        <span>等待你主动打开资源</span>
      </div>
    </div>
  );
}

export function AgentResourcePanel({
  navigation,
  collapsed,
  onToggleCollapse,
}: {
  navigation: AgentResourceNavigation;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  if (collapsed) {
    return <CollapsedRail onToggleCollapse={onToggleCollapse} />;
  }

  const { current, reloadToken, openResource, openFullPage } = navigation;
  const onOpenResource = (request: AgentResourceRequest) => void openResource(request);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-background shadow-sm">
      <PanelHeader navigation={navigation} onToggleCollapse={onToggleCollapse} />
      <ScrollArea className="min-h-0 flex-1">
        {current ? (
          <AgentResourceRenderer
            location={current}
            mode="panel"
            reloadToken={reloadToken}
            onOpenResource={onOpenResource}
            onOpenFullPage={openFullPage}
          />
        ) : (
          <EmptyState />
        )}
      </ScrollArea>
    </div>
  );
}
