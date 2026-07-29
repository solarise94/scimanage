import { registerPlugin } from "../registry";
import type { FormDraftPlugin, FormDraftResult, PluginActor, ProjectPluginContext } from "../types";
import { runDraftOrchestrator } from "@/lib/draft/orchestrator";
import { isDraftAIConfigured } from "@/lib/draft/providers";

const projectAutoDraft: FormDraftPlugin = {
  manifest: {
    key: "project.auto-draft",
    name: "AI 智能填写",
    description: "从文本中智能提取项目信息，支持实体匹配和搜索补齐，生成可审阅草稿",
    capability: "form-draft",
    formKeys: ["project.create", "project.edit", "customer.create", "ticket.create", "order.create"],
  },
  async execute(
    input: string | Record<string, unknown>,
    actor: PluginActor,
    formKey: string,
    projectCtx?: ProjectPluginContext,
  ): Promise<FormDraftResult> {
    if (!isDraftAIConfigured()) {
      throw new Error("AI 未配置，请联系管理员设置 MINIMAX_API_KEY");
    }

    // After the text-first refactor, input is always a string
    const payload = typeof input === "string" ? input : String(input.text || input);

    const { artifact } = await runDraftOrchestrator({
      payload,
      formKey,
      projectCtx,
      actor,
    });

    const fieldCount = Object.keys(artifact.fields).length;
    const summary = fieldCount > 0
      ? `提取到 ${fieldCount} 个字段`
      : "未能提取到有效字段";

    return {
      summary,
      warnings: artifact.warnings,
      draft: {
        fields: artifact.fields,
        fieldMeta: artifact.fieldMeta,
        sources: artifact.sources,
      },
    };
  },
};

registerPlugin(projectAutoDraft);
