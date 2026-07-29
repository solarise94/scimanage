"use client";

import { useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";

/**
 * P1-3 UI 接线：模型驱动的 proposal 创建被 NEEDS_USER_CONFIRMATION(409) 拒后，
 * 在消息流里渲染的「需要你的确认」卡片（替代红色错误行）。
 *
 * 交互流程（cutover checklist §4 P1-3 allowProposal 的 UI 侧）：
 *  1. 模型在 dynamic-bundle 链路调 propose_* → createAgentProposal 缺确认事件 → 409；
 *  2. facade/executor/route 透传 targetIntent（= action.key），runtime tool_error 带到 timeline；
 *  3. 本卡片渲染动作名 + 文案 + 「确认执行」按钮；
 *  4. 点击 → POST /api/agent/confirmation-events mint 一次性事件
 *     （idempotencyKey = `${agentRunId}:${targetIntent}:${crypto.randomUUID()}`）；
 *  5. 成功后调 onConfirmed（→ onSendPrefilled「我已确认，请重新执行刚才的操作」），
 *     模型重调 propose_*，这次有事件可消费 → PENDING proposal；
 *  6. 失败（409 已消费 / 404 他人 run / 400 缺字段 / 网络错）→ toast 错误，按钮恢复可点。
 *
 * 不走 AgentUiRenderer / ACTION_UI_MAP（它是错误分支而非 action 输出），
 * 由 agent-message-feed 在 tool error 分支直接构造渲染。
 *
 * 注意：本组件刻意不依赖 AgentCardProps（不经过注册表的 RegisteredCard 路径），
 * 入参收窄为渲染 + mint 所需的最小字段集，便于单测与退化。
 */
export function AgentNeedsUserConfirmationCard({
  label,
  targetIntent,
  agentRunId,
  onConfirmed,
}: {
  /** 友好动作名（friendlyToolLabel(item.toolName, item.label)）。 */
  label: string;
  /** 需要确认的 confirm actionKey（来自 tool_error 事件透传）。缺失则按钮禁用。 */
  targetIntent?: string;
  /** 当前会话绑定的 AgentRun id。缺失则按钮禁用并提示。 */
  agentRunId?: string | null;
  /** mint 成功后的回调（由 feed 注入 onSendPrefilled）。 */
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const canConfirm = Boolean(targetIntent) && Boolean(agentRunId) && !busy && !done;

  async function handleConfirm() {
    if (!targetIntent || !agentRunId || busy || done) return;
    setBusy(true);
    try {
      // 幂等键：每次点击生成新 UUID。一次点击对应一次 mint，重放由服务端幂等表兜底。
      const idempotencyKey = `${agentRunId}:${targetIntent}:${crypto.randomUUID()}`;
      const res = await fetch("/api/agent/confirmation-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentRunId, targetIntent, idempotencyKey }),
      });
      // 201 新建 / 200 幂等命中都算成功（服务端对同 idempotencyKey 返回同事件）。
      if (res.status === 201 || res.status === 200) {
        setDone(true);
        toast.success("已确认，正在重新生成提案");
        onConfirmed();
        return;
      }
      // 409 已消费 / tuple 不匹配；404 他人 run；400 缺字段；其他。
      let detail = "确认失败，请稍后重试";
      try {
        const body = (await res.json()) as { error?: string; code?: string };
        if (typeof body.error === "string" && body.error.trim()) detail = body.error.trim();
      } catch {
        // 响应非 JSON，保留通用文案
      }
      toast.error(detail);
    } catch {
      // 网络错 / 中断：不崩溃消息流，提示后允许重试。
      toast.error("网络异常，未能完成确认");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title={label} state="pending">
      <div className="flex items-start gap-2 py-1 text-[13px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 break-words">
          该操作需要你的明确确认才能生成提案。点击下方按钮确认后，将自动重新发起。
          {!targetIntent ? (
            <span className="mt-1 block text-[12px] text-danger">
              缺少目标操作标识，无法确认。
            </span>
          ) : null}
          {!agentRunId ? (
            <span className="mt-1 block text-[12px] text-danger">
              当前会话未绑定运行记录，无法确认。
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button type="button" size="sm" disabled={!canConfirm} onClick={handleConfirm}>
          {busy ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              确认中
            </>
          ) : done ? (
            "已确认"
          ) : (
            "确认执行"
          )}
        </Button>
      </div>
    </CardShell>
  );
}
