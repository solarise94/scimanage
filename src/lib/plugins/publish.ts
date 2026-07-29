import { prisma } from "@/lib/prisma";

interface PluginMessage {
  content: string;
  format?: "plain" | "markdown";
  metadata?: Record<string, unknown>;
}

export async function publishPluginMessage(
  projectId: string,
  pluginKey: string,
  pluginName: string,
  message: PluginMessage,
) {
  return prisma.activityLog.create({
    data: {
      type: "PLUGIN_MESSAGE",
      content: message.content,
      metadata: JSON.stringify({
        pluginKey,
        pluginName,
        renderMode: "comment",
        format: message.format || "plain",
        ...(message.metadata || {}),
      }),
      projectId,
      userId: null,
    },
  });
}
