import { registerPlugin } from "../registry";
import type { TimelinePlugin, ProjectPluginContext, TimelinePluginResult } from "../types";

const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  ON_HOLD: "暂停",
  TERMINATED: "终止",
};

const TICKET_STATUS_LABELS: Record<string, string> = {
  OPEN: "打开",
  IN_PROGRESS: "处理中",
  CLOSED: "已关闭",
};

function buildDigest(ctx: ProjectPluginContext): string {
  const { project, customer, representativeDetail, tickets, timeline } = ctx;
  const lines: string[] = [];

  lines.push(`**${project.name}** 项目快照`);
  lines.push("");
  lines.push(`- 状态：${STATUS_LABELS[project.status] || project.status}`);
  lines.push(`- 进度：${project.progress}%`);
  if (project.organization) lines.push(`- 单位：${project.organization}`);
  if (project.client) lines.push(`- 委托人：${project.client}`);
  if (representativeDetail) lines.push(`- 业务代表：${representativeDetail.name}`);

  if (customer) {
    lines.push("");
    lines.push(`**客户** ${customer.name}（${customer.customerCode}）`);
    if (customer.organization) lines.push(`- 所属机构：${customer.organization}`);
  }

  if (tickets.length > 0) {
    lines.push("");
    const open = tickets.filter((t) => t.status !== "CLOSED").length;
    const closed = tickets.filter((t) => t.status === "CLOSED").length;
    lines.push(`**工单** 共 ${tickets.length} 条（${open} 进行中，${closed} 已关闭）`);
    for (const t of tickets.slice(0, 5)) {
      lines.push(`- [${TICKET_STATUS_LABELS[t.status] || t.status}] ${t.title}`);
    }
    if (tickets.length > 5) lines.push(`- ...及其他 ${tickets.length - 5} 条`);
  }

  if (timeline.length > 0) {
    lines.push("");
    lines.push(`**最近动态**（${timeline.length} 条）`);
    for (const item of timeline.slice(0, 5)) {
      const who = item.user?.name || "系统";
      lines.push(`- ${who}：${item.content.slice(0, 60)}${item.content.length > 60 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}

const projectDigest: TimelinePlugin = {
  manifest: {
    key: "project.digest",
    name: "项目快照",
    description: "生成项目当前状态的快照摘要，发布到时间流",
    capability: "timeline",
  },
  async execute(ctx: ProjectPluginContext): Promise<TimelinePluginResult> {
    const content = buildDigest(ctx);
    return {
      summary: `已生成 ${ctx.project.name} 的项目快照`,
      message: {
        content,
        format: "markdown",
      },
    };
  },
};

registerPlugin(projectDigest);
