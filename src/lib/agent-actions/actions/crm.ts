import { canReadCrmAgent, canUseCrmAgent } from "@/lib/crm/application/crm-agent-access";
import { requestOrganizationBindingForActor } from "@/lib/crm/application/request-organization-binding";
import { submitCustomerApplicationForActor } from "@/lib/crm/application/submit-customer-application";
import { searchCustomersForActor } from "@/lib/crm/application/query-customers";
import { getCustomerContextForActor } from "@/lib/crm/application/get-customer-context";
import {
  resolveCustomerNameForActor,
  searchCustomersByPinyinForActor,
} from "@/lib/crm/application/resolve-customer-name";
import { listMyOrganizationsForActor } from "@/lib/crm/application/list-my-organizations";
import { listMyCustomerApplicationsForActor } from "@/lib/crm/application/list-my-customer-applications";
import {
  createFollowUpTaskForActor,
  resolveFollowUpOwnerForActor,
} from "@/lib/crm/application/create-followup-task";
import { prepareVisitCheckinForActor } from "@/lib/crm/application/prepare-visit-checkin";
import { createVisitCheckinForActor } from "@/lib/crm/application/create-visit-checkin";
import {
  createInteractionForActor,
  INTERACTION_TYPE_LABELS,
} from "@/lib/crm/application/create-interaction";
import { registerAgentAction } from "../registry";
import { AgentActionForbiddenError, AgentActionInputError, mapDomainErrorToAgentError } from "../errors";
import { arraySchema, clampLimit, ensureObject, integerSchema, numberSchema, objectSchema, readOptionalInteger, readOptionalNumber, readOptionalString, readRequiredString, stringSchema } from "../schemas";

/**
 * CRM Agent action 角色矩阵（单一真相源；改动务必同步下表）。
 *
 * | action                              | 类别   | 允许角色（availability）              | helper             |
 * |-------------------------------------|--------|---------------------------------------|--------------------|
 * | crm.search_customers                | 读类   | REPRESENTATIVE / REGIONAL_MANAGER / ADMIN | canReadCrmAgent |
 * | crm.get_customer_context            | 读类   | REPRESENTATIVE / REGIONAL_MANAGER / ADMIN | canReadCrmAgent |
 * | crm.list_my_organizations           | 读类   | REPRESENTATIVE / REGIONAL_MANAGER / ADMIN | canReadCrmAgent |
 * | crm.resolve_customer_name           | 读类   | REPRESENTATIVE / REGIONAL_MANAGER / ADMIN | canReadCrmAgent |
 * | crm.search_customers_by_pinyin      | 读类   | REPRESENTATIVE / REGIONAL_MANAGER / ADMIN | canReadCrmAgent |
 * | crm.prepare_visit_checkin           | 写类   | REPRESENTATIVE / ADMIN                | canUseCrmAgent     |
 * | crm.create_followup_task            | 写类   | REPRESENTATIVE / ADMIN                | canUseCrmAgent     |
 * | crm.create_visit_checkin            | 写类   | REPRESENTATIVE / ADMIN                | canUseCrmAgent     |
 * | crm.create_interaction              | 写类   | REPRESENTATIVE / ADMIN                | canUseCrmAgent     |
 * | crm.request_organization_binding    | 写类   | REPRESENTATIVE / ADMIN                | canUseCrmAgent     |
 * | crm.submit_customer_application     | 写类   | REPRESENTATIVE / ADMIN                | canUseCrmAgent     |
 * | crm.list_my_customer_applications   | 写类*  | REPRESENTATIVE / ADMIN                | canUseCrmAgent     |
 *
 * 「写类*」：list_my_customer_applications 本身是只读查询，但它返回的是「代表自助」
 * 能力（查看本人提交的客户申请），不属于 RM 的「读类 CRM」范畴，因此仍归 canUseCrmAgent。
 *
 * 入口（页面/导航）只决定能否进入 /agent；具体能力开放与否由上面每个 action 的
 * availability 控制。不要把入口 helper 与这里的细粒度 helper 混用。
 */

async function mapQueryError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "客户资料" });
  }
}

function inputSchema() {
  return objectSchema({
    query: stringSchema("关键词，可匹配客户名、编号、机构、负责人"),
    stage: stringSchema("CRM 阶段"),
    limit: integerSchema("返回条数，默认 10，最大 30", { minimum: 1, maximum: 30 }),
  });
}

function outputSchema() {
  return objectSchema({
    items: {
      type: "array",
      items: objectSchema({
        profileId: stringSchema(),
        customerName: stringSchema(),
        organization: stringSchema(),
        stage: stringSchema(),
        importance: stringSchema(),
        ownerName: stringSchema(),
        lastInteractionAt: stringSchema(),
        followUpCount: integerSchema(),
        interactionCount: integerSchema(),
      }),
    },
  });
}

function createFollowUpInputSchema() {
  return objectSchema({
    profileId: stringSchema("CRM profile ID"),
    ownerUserId: stringSchema("负责人用户 ID，销售本人会忽略该字段"),
    title: stringSchema("跟进任务标题"),
    dueAt: stringSchema("截止时间，ISO 时间字符串"),
    taskType: stringSchema("任务类型：CONTACT（沟通跟进）| VISIT（拜访计划）| OTHER（其他），默认 CONTACT"),
  }, ["profileId", "title", "dueAt"]);
}

function createFollowUpOutputSchema() {
  return objectSchema({
    task: objectSchema({
      id: stringSchema(),
      profileId: stringSchema(),
      customerName: stringSchema(),
      ownerUserId: stringSchema(),
      title: stringSchema(),
      status: stringSchema(),
      dueAt: stringSchema(),
    }),
    notifications: arraySchema(stringSchema()),
  });
}

export function registerCrmActions() {
  registerAgentAction({
    key: "crm.search_customers",
    title: "搜索 CRM 客户",
    description: "搜索当前用户可见的 CRM 客户资料。后续详情/签到/沟通等工具必须使用返回的 items[].profileId，不要用 customerId。",
    domain: "crm",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: inputSchema(),
    outputSchema: outputSchema(),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        query: readOptionalString(input, "query"),
        stage: readOptionalString(input, "stage"),
        limit: clampLimit(readOptionalInteger(input, "limit", { min: 1, max: 30 }), 10, 30),
      };
    },
    async availability(actor) {
      return canReadCrmAgent(actor.role);
    },
    async execute(ctx, input) {
      return mapQueryError(() =>
        searchCustomersForActor(ctx.actor, {
          query: input.query,
          stage: input.stage,
          limit: input.limit,
        }),
      );
    },
  });

  registerAgentAction({
    key: "crm.create_followup_task",
    title: "创建 CRM 跟进任务",
    description: "为指定 CRM 客户资料创建待确认的跟进任务。",
    domain: "crm",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: createFollowUpInputSchema(),
    outputSchema: createFollowUpOutputSchema(),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      const taskType = readOptionalString(input, "taskType");
      return {
        profileId: readRequiredString(input, "profileId"),
        ownerUserId: readOptionalString(input, "ownerUserId"),
        title: readRequiredString(input, "title"),
        dueAt: readRequiredString(input, "dueAt"),
        taskType: taskType && ["CONTACT", "VISIT", "OTHER"].includes(taskType) ? taskType : undefined,
      };
    },
    async availability(actor) {
      return canUseCrmAgent(actor.role);
    },
    async buildProposal(ctx, input) {
      const businessActor = ctx.actor;
      const context = await mapQueryError(() =>
        getCustomerContextForActor(businessActor, input.profileId),
      );
      const finalOwner = await resolveFollowUpOwnerForActor(businessActor, input.ownerUserId);
      return {
        title: `创建跟进任务：${input.title}`,
        summary: `客户「${context.customerName}」将新增一条跟进任务，截止时间 ${new Date(input.dueAt).toLocaleString("zh-CN")}，负责人用户 ID 为 ${finalOwner}。`,
        target: { type: "crm_profile", id: context.profileId },
      };
    },
    async execute(ctx, input) {
      const businessActor = ctx.actor;
const { invocation } = ctx;
      try {
        const result = await createFollowUpTaskForActor(businessActor, invocation, {
          profileId: input.profileId,
          ownerUserId: input.ownerUserId,
          title: input.title,
          dueAt: input.dueAt,
          taskType: input.taskType,
        });
        return {
          task: {
            id: result.task.id,
            profileId: result.task.profileId,
            customerName: result.customerName,
            ownerUserId: result.task.ownerUserId,
            title: result.task.title,
            status: result.task.status,
            dueAt: result.task.dueAt.toISOString(),
          },
          notifications: result.notifications,
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "客户资料" });
      }
    },
    resolveTarget(_input, output) {
      return { type: "crm_follow_up_task", id: output.task.id };
    },
  });

  // ---- crm.get_customer_context ----
  registerAgentAction({
    key: "crm.get_customer_context",
    title: "查看客户详情",
    description: "按 CRM profileId 读取单个客户档案、机构与近期互动。profileId 必须来自 crm.search_customers 返回的 items[].profileId，不要传 customerId 或客户姓名。",
    domain: "crm",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema({
      profileId: stringSchema("CRM 客户资料 ID（CrmCustomerProfile.id）。必须使用 crm.search_customers 返回的 items[].profileId，禁止传 customerId/姓名"),
    }, ["profileId"]),
    outputSchema: objectSchema({
      profileId: stringSchema(),
      customerName: stringSchema(),
      stage: stringSchema(),
      importance: stringSchema(),
      organization: stringSchema(),
      principal: stringSchema(),
      ownerName: stringSchema(),
      email: stringSchema(),
      wechat: stringSchema(),
      lastInteractionAt: stringSchema(),
      recentInteractions: arraySchema(objectSchema({
        id: stringSchema(),
        type: stringSchema(),
        summary: stringSchema(),
        happenedAt: stringSchema(),
      })),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      return { profileId: readRequiredString(input, "profileId") };
    },
    async availability(actor) {
      return canReadCrmAgent(actor.role);
    },
    async execute(ctx, input) {
      return mapQueryError(() => getCustomerContextForActor(ctx.actor, input.profileId));
    },
  });

  // ---- crm.resolve_customer_name ----
  // 语音/模糊客户名解析：把可能含同音错字的姓名解析为 scope 内候选 Profile。
  // 候选必须只在 getEffectiveCrmVisibleProfileIds 内召回（scope-first 硬安全）。
  registerAgentAction({
    key: "crm.resolve_customer_name",
    title: "解析客户姓名（语音/模糊）",
    description:
      "语音/模糊客户名解析：把可能含同音错字的姓名解析为 scope 内候选 Profile，返回 resolution 与 candidates；解析出的 profileId 才能用于后续读/写工具。",
    domain: "crm",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema(
      {
        spokenName: stringSchema("客户姓名片段（可能含同音错字，如语音转写结果）"),
        organizationHint: stringSchema("机构/单位线索，可选，用于消歧加分"),
        principalHint: stringSchema("负责人/PI 线索，可选，用于消歧加分"),
        inputMode: stringSchema("输入模式：voice（语音转写）| text（文本输入）。默认按 voice 处理同音错字"),
        limit: integerSchema("返回候选数，默认 5，最大 10", { minimum: 1, maximum: 10 }),
      },
      ["spokenName"],
    ),
    outputSchema: objectSchema({
      normalizedSpokenName: stringSchema(),
      resolution: stringSchema("UNIQUE（唯一命中）| AMBIGUOUS（多个候选需用户点选）| NO_MATCH（无候选）"),
      candidates: arraySchema(
        objectSchema({
          profileId: stringSchema(),
          name: stringSchema(),
          organization: stringSchema(),
          ownerName: stringSchema(),
          score: integerSchema(),
          reasons: arraySchema(stringSchema()),
        }),
      ),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const inputModeRaw = readOptionalString(input, "inputMode");
      const inputMode = inputModeRaw === "voice" || inputModeRaw === "text" ? inputModeRaw : undefined;
      const limitRaw = readOptionalInteger(input, "limit", { min: 1, max: 10 });
      return {
        spokenName: readRequiredString(input, "spokenName"),
        organizationHint: readOptionalString(input, "organizationHint"),
        principalHint: readOptionalString(input, "principalHint"),
        inputMode,
        limit: limitRaw ?? 5,
      };
    },
    async availability(actor) {
      return canReadCrmAgent(actor.role);
    },
    async execute(ctx, input) {
      return mapQueryError(() =>
        resolveCustomerNameForActor(ctx.actor, {
          spokenName: input.spokenName,
          organizationHint: input.organizationHint,
          principalHint: input.principalHint,
          limit: input.limit,
        }),
      );
    },
  });

  // ---- crm.search_customers_by_pinyin ----
  // 拼音搜索工具（docs §6）：热客户列表未命中、或语音转写可能含同音错字时的客户召回。
  // resolution 来自 scoreAndResolve 基于完整候选前两名的结论（多候选不再被 limit 截断
  // 误判唯一，见 AGENTS review P1#1）；candidates 仍按 limit 截断用于展示。两个 chat route
  // 统一消费 resolution==="UNIQUE" 决定是否自动查详情，不再用候选数/matchType 二次推断。
  registerAgentAction({
    key: "crm.search_customers_by_pinyin",
    title: "拼音/同音召回客户",
    description:
      "热客户列表未命中、或语音转写可能含同音错字（如「王小明」实为客户「王晓明」）、或用户输入拼音/拼音首字母（如 zsy）时的客户召回工具。返回 resolution（UNIQUE/AMBIGUOUS/NO_MATCH，基于完整候选结论）与候选列表；resolution=UNIQUE 时调用方可自动读取客户名片，否则需用户点选。候选 profileId 才能用于后续读/写工具。",
    domain: "crm",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema(
      {
        spokenName: stringSchema("客户姓名片段，可能是语音转写同音错字、拼音或拼音首字母"),
        limit: integerSchema("返回候选数，默认 5，最大 10（超出会被夹到 10）", { minimum: 1 }),
      },
      ["spokenName"],
    ),
    outputSchema: objectSchema({
      query: stringSchema(),
      queryPinyin: stringSchema(),
      resolution: stringSchema("UNIQUE（唯一命中）| AMBIGUOUS（多个候选需用户点选）| NO_MATCH（无候选）；基于完整候选结论，不受 limit 截断影响"),
      candidates: arraySchema(
        objectSchema({
          profileId: stringSchema(),
          name: stringSchema(),
          namePinyin: stringSchema(),
          organization: stringSchema(),
          principal: stringSchema(),
          ownerName: stringSchema(),
          score: integerSchema(),
          matchType: stringSchema(),
          signals: arraySchema(stringSchema()),
        }),
      ),
      total: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      // 接受任意正整数后用 clampLimit 夹到 1..10（docs §6.1：limit clamp 1..10，默认 5）。
      // 不在 schema 层硬拒 >10，避免模型传 limit=50 时直接报错破坏体验。
      const limitRaw = readOptionalInteger(input, "limit", { min: 1 });
      return {
        spokenName: readRequiredString(input, "spokenName"),
        limit: clampLimit(limitRaw ?? 5, 1, 10),
      };
    },
    async availability(actor) {
      return canReadCrmAgent(actor.role);
    },
    async execute(ctx, input) {
      return mapQueryError(() =>
        searchCustomersByPinyinForActor(ctx.actor, {
          spokenName: input.spokenName,
          limit: input.limit,
        }),
      );
    },
  });

  // ---- crm.prepare_visit_checkin ----
  registerAgentAction({
    key: "crm.prepare_visit_checkin",
    title: "准备现场签到",
    description: "校验客户并准备签到草稿，返回客户信息供签到卡片使用。profileId 必须原样来自本轮或历史 crm.search_customers / 客户解析工具的输出，禁止根据姓名生成 ID；已有已确认 profileId 时不要重复搜索。",
    domain: "crm",
    riskLevel: "safe",
    // P0-4：Agent channel 会持久化 DRAFT checkin 作为服务端 intent 锚点（非终态业务写），
    // 故不再标 readOnly——/api/agent/actions 列表元数据需如实反映副作用。
    readOnly: false,
    inputSchema: objectSchema({
      profileId: stringSchema("CRM profile ID"),
    }, ["profileId"]),
    outputSchema: objectSchema({
      profileId: stringSchema(),
      customerName: stringSchema(),
      organization: stringSchema(),
      checkinReady: stringSchema(),
      checkinId: stringSchema("Agent channel 下创建的 DRAFT checkin ID（intent 锚点）"),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      return { profileId: readRequiredString(input, "profileId") };
    },
    async availability(actor) {
      return canUseCrmAgent(actor.role);
    },
    async execute(ctx, input) {
      const businessActor = ctx.actor;
const { invocation } = ctx;
      return mapQueryError(() =>
        prepareVisitCheckinForActor(businessActor, invocation, input.profileId),
      );
    },
  });

  // ---- crm.create_visit_checkin ----
  registerAgentAction({
    key: "crm.create_visit_checkin",
    title: "现场签到",
    description: "对外单一确认动作；内部严格复用签到 DRAFT 创建与 COMPLETED 完成流程。",
    domain: "crm",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: objectSchema({
      profileId: stringSchema("CRM profile ID"),
      lat: numberSchema("纬度，来自浏览器定位"),
      lng: numberSchema("经度，来自浏览器定位"),
      accuracy: numberSchema("定位精度（米）"),
      capturedAt: stringSchema("定位采集时间，ISO 字符串"),
      addressNote: stringSchema("可选地址备注"),
      checkinId: stringSchema("已有 DRAFT checkin ID（上传照片后传入）"),
    }, ["profileId", "lat", "lng", "capturedAt"]),
    outputSchema: objectSchema({
      checkin: objectSchema({
        id: stringSchema(),
        status: stringSchema(),
        addressSnapshot: stringSchema(),
        completedAt: stringSchema(),
      }),
      interaction: objectSchema({
        id: stringSchema(),
        type: stringSchema(),
      }),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      const lat = readOptionalNumber(input, "lat", { min: -90, max: 90 });
      const lng = readOptionalNumber(input, "lng", { min: -180, max: 180 });
      if (lat == null || lng == null) {
        throw new AgentActionInputError("lat and lng are required for visit checkin");
      }
      const capturedAtStr = readRequiredString(input, "capturedAt");
      const capturedAt = new Date(capturedAtStr);
      if (Number.isNaN(capturedAt.getTime())) {
        throw new AgentActionInputError("capturedAt must be a valid ISO date string");
      }
      // Validate location freshness (default 5 minutes)
      const maxAgeMs = 5 * 60 * 1000;
      if (Date.now() - capturedAt.getTime() > maxAgeMs) {
        throw new AgentActionInputError("定位数据已过期，请重新获取当前位置");
      }
      return {
        profileId: readRequiredString(input, "profileId"),
        lat,
        lng,
        accuracy: readOptionalNumber(input, "accuracy"),
        capturedAt: capturedAtStr,
        addressNote: readOptionalString(input, "addressNote"),
        checkinId: readOptionalString(input, "checkinId"),
      };
    },
    async availability(actor) {
      return canUseCrmAgent(actor.role);
    },
    async buildProposal(ctx, input) {
      const businessActor = ctx.actor;
      const context = await mapQueryError(() =>
        getCustomerContextForActor(businessActor, input.profileId),
      );

      return {
        title: `现场签到：${context.customerName}`,
        summary: `将在客户「${context.customerName}」下创建一条现场签到记录（经纬度证据来自设备定位）。`,
        target: { type: "crm_profile", id: context.profileId },
        proposalInput: {
          ...input,
          profileId: context.profileId,
          customerName: context.customerName,
        },
      };
    },
    async execute(ctx, input) {
      const businessActor = ctx.actor;
const { invocation } = ctx;
      try {
        const result = await createVisitCheckinForActor(businessActor, invocation, {
          profileId: input.profileId,
          lat: input.lat,
          lng: input.lng,
          accuracy: input.accuracy,
          addressNote: input.addressNote,
          checkinId: input.checkinId,
        });
        return {
          checkin: {
            id: result.checkin.id,
            status: result.checkin.status,
            addressSnapshot: result.checkin.addressSnapshot ?? "",
            completedAt: result.checkin.completedAt?.toISOString() ?? "",
          },
          interaction: result.interaction
            ? { id: result.interaction.id, type: result.interaction.type }
            : { id: "", type: "" },
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "客户资料" });
      }
    },
    resolveTarget(_input, output) {
      return { type: "crm_visit_checkin", id: output.checkin.id };
    },
  });

  // ---- crm.create_interaction ----
  registerAgentAction({
    key: "crm.create_interaction",
    title: "创建沟通记录",
    description: "创建电话、微信、邮件、会议、拜访等沟通记录。",
    domain: "crm",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: objectSchema({
      profileId: stringSchema("CRM profile ID"),
      type: stringSchema("类型：CALL|WECHAT|EMAIL|MEETING|VISIT|REFERRAL|NOTE"),
      summary: stringSchema("摘要，必填"),
      detail: stringSchema("详情，可选"),
      happenedAt: stringSchema("发生时间，ISO 字符串"),
      nextActionAt: stringSchema("下次行动时间，可选，ISO 字符串"),
      relatedProjectId: stringSchema("关联项目 ID，可选"),
    }, ["profileId", "type", "summary", "happenedAt"]),
    outputSchema: objectSchema({
      interaction: objectSchema({
        id: stringSchema(),
        profileId: stringSchema(),
        type: stringSchema(),
        summary: stringSchema(),
        happenedAt: stringSchema(),
      }),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      const type = readRequiredString(input, "type");
      const validTypes = ["CALL", "WECHAT", "EMAIL", "MEETING", "VISIT", "REFERRAL", "NOTE"];
      if (!validTypes.includes(type)) {
        throw new AgentActionInputError(`type must be one of: ${validTypes.join(", ")}`);
      }
      const happenedAtStr = readRequiredString(input, "happenedAt");
      const happenedAt = new Date(happenedAtStr);
      if (Number.isNaN(happenedAt.getTime())) {
        throw new AgentActionInputError("happenedAt must be a valid ISO date string");
      }
      const nextActionAtStr = readOptionalString(input, "nextActionAt");
      let nextActionAt: Date | null | undefined = undefined;
      if (nextActionAtStr) {
        const parsed = new Date(nextActionAtStr);
        if (Number.isNaN(parsed.getTime())) {
          throw new AgentActionInputError("nextActionAt must be a valid ISO date string");
        }
        nextActionAt = parsed;
      }
      return {
        profileId: readRequiredString(input, "profileId"),
        type,
        summary: readRequiredString(input, "summary"),
        detail: readOptionalString(input, "detail"),
        happenedAt: happenedAtStr,
        nextActionAt: nextActionAt ? nextActionAt.toISOString() : undefined,
        relatedProjectId: readOptionalString(input, "relatedProjectId"),
        // Display-only field for GenUI draft card title; ignored by execute().
        customerName: readOptionalString(input, "customerName"),
      };
    },
    async availability(actor) {
      return canUseCrmAgent(actor.role);
    },
    async buildProposal(ctx, input) {
      const businessActor = ctx.actor;
      const context = await mapQueryError(() =>
        getCustomerContextForActor(businessActor, input.profileId),
      );
      const customerName = context.customerName ?? input.customerName ?? "未命名客户";

      return {
        title: `创建沟通记录：${INTERACTION_TYPE_LABELS[input.type] ?? input.type}`,
        summary: `客户「${customerName}」新增一条${INTERACTION_TYPE_LABELS[input.type] ?? input.type}记录：${input.summary}`,
        proposalInput: { ...input, customerName },
        target: { type: "crm_profile", id: context.profileId },
        displayProps: { customerName },
      };
    },
    async execute(ctx, input) {
      const businessActor = ctx.actor;
const { invocation } = ctx;
      try {
        const result = await createInteractionForActor(businessActor, invocation, {
          profileId: input.profileId,
          type: input.type,
          summary: input.summary,
          detail: input.detail,
          happenedAt: input.happenedAt,
          nextActionAt: input.nextActionAt,
          relatedProjectId: input.relatedProjectId,
        });
        return {
          interaction: {
            id: result.interaction.id,
            profileId: result.interaction.profileId,
            type: result.interaction.type,
            summary: result.interaction.summary,
            happenedAt: result.interaction.happenedAt.toISOString(),
          },
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "客户资料" });
      }
    },
    resolveTarget(_input, output) {
      return { type: "crm_interaction", id: output.interaction.id };
    },
  });

  // ---- crm.list_my_organizations ----
  registerAgentAction({
    key: "crm.list_my_organizations",
    title: "查看我的单位绑定",
    description: "查看当前代表已绑定的单位和绑定状态。",
    domain: "crm",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      items: arraySchema(objectSchema({
        id: stringSchema(),
        organizationName: stringSchema(),
        siteName: stringSchema(),
        status: stringSchema(),
        isPrimary: stringSchema(),
      })),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      ensureObject(raw);
      return {};
    },
    async availability(actor) {
      return canReadCrmAgent(actor.role);
    },
    async execute(ctx) {
      return mapQueryError(() => listMyOrganizationsForActor(ctx.actor));
    },
  });

  // ---- crm.request_organization_binding ----
  registerAgentAction({
    key: "crm.request_organization_binding",
    title: "申请单位绑定",
    description: "申请已有单位/院区绑定，或提报新单位。代表提交后始终为 PENDING。",
    domain: "crm",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: objectSchema({
      organizationId: stringSchema("已有机构 ID"),
      canonicalName: stringSchema("新单位名称（提报新单位时使用）"),
      organizationSiteId: stringSchema("院区 ID（仅已有单位可选）"),
    }),
    outputSchema: objectSchema({
      binding: objectSchema({
        id: stringSchema(),
        status: stringSchema(),
        organizationName: stringSchema(),
      }),
      isNewOrg: stringSchema(),
      warnings: arraySchema(stringSchema()),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      const organizationId = readOptionalString(input, "organizationId");
      const canonicalName = readOptionalString(input, "canonicalName");
      if (!organizationId && !canonicalName) {
        throw new AgentActionInputError("organizationId 或 canonicalName 至少需要一个");
      }
      return {
        organizationId,
        canonicalName,
        organizationSiteId: readOptionalString(input, "organizationSiteId"),
      };
    },
    async availability(actor) {
      return canUseCrmAgent(actor.role);
    },
    async buildProposal(ctx, input) {
      // For new org, siteId is not allowed
      if (!input.organizationId && input.organizationSiteId) {
        throw new AgentActionInputError("新单位申请不能指定院区");
      }

      const title = input.organizationId
        ? "申请绑定已有单位"
        : `提报新单位：${input.canonicalName}`;

      return {
        title,
        summary: input.organizationId
          ? `申请绑定单位（ID: ${input.organizationId}），提交后状态为 PENDING，等待审核。`
          : `提报新单位「${input.canonicalName}」，将创建审核任务并提交 PENDING 绑定申请。`,
      };
    },
    async execute(ctx, input) {
      const businessActor = ctx.actor;
const { invocation } = ctx;
      try {
        const result = await requestOrganizationBindingForActor(businessActor, invocation, {
          organizationId: input.organizationId,
          canonicalName: input.canonicalName,
          organizationSiteId: input.organizationSiteId,
        });

        return {
          binding: {
            id: result.binding.id,
            status: result.binding.status,
            organizationName:
              result.binding.organization?.canonicalName ??
              result.binding.requestedOrganizationName ??
              "",
          },
          isNewOrg: result.isNewOrg ? "true" : "false",
          warnings: result.warnings,
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "单位绑定" });
      }
    },
    resolveTarget(_input, output) {
      return { type: "representative_organization", id: output.binding.id };
    },
  });

  // ---- crm.submit_customer_application ----
  registerAgentAction({
    key: "crm.submit_customer_application",
    title: "提交新增客户申请",
    description: "提交新增客户申请，必须选择有效单位。强重复需用户二次确认。",
    domain: "crm",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: objectSchema({
      name: stringSchema("客户姓名，必填"),
      organizationId: stringSchema("单位 ID，必填"),
      organizationSiteId: stringSchema("院区 ID，可选"),
      principal: stringSchema("PI/负责人"),
      email: stringSchema("邮箱"),
      wechat: stringSchema("微信"),
      miniProgramId: stringSchema("小程序 ID"),
      address: stringSchema("地址"),
      notes: stringSchema("备注"),
      // duplicateDecision is NOT exposed to the model - only set via PATCH by
      // the card after the user explicitly confirms "still create new".
    }, ["name", "organizationId"]),
    outputSchema: objectSchema({
      application: objectSchema({
        id: stringSchema(),
        status: stringSchema(),
        supervisorReviewStatus: stringSchema(),
      }),
      profileId: stringSchema(),
      duplicateCandidates: arraySchema(objectSchema({
        id: stringSchema(),
        name: stringSchema(),
        customerCodeLast6: stringSchema(),
        organization: stringSchema(),
        matchReasons: arraySchema(stringSchema()),
      })),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      const input = ensureObject(raw);
      const duplicateDecision = readOptionalString(input, "duplicateDecision");
      return {
        name: readRequiredString(input, "name"),
        organizationId: readRequiredString(input, "organizationId"),
        organizationSiteId: readOptionalString(input, "organizationSiteId"),
        principal: readOptionalString(input, "principal"),
        email: readOptionalString(input, "email"),
        wechat: readOptionalString(input, "wechat"),
        miniProgramId: readOptionalString(input, "miniProgramId"),
        address: readOptionalString(input, "address"),
        notes: readOptionalString(input, "notes"),
        duplicateDecision: (duplicateDecision === "CREATE_NEW" ? "CREATE_NEW" : undefined) as "CREATE_NEW" | undefined,
      };
    },
    async availability(actor) {
      return canUseCrmAgent(actor.role);
    },
    async buildProposal(ctx, input) {
      const businessActor = ctx.actor;
const { invocation } = ctx;
      let result;
      try {
        result = await submitCustomerApplicationForActor(businessActor, invocation, {
          name: input.name,
          organizationId: input.organizationId,
          organizationSiteId: input.organizationSiteId,
          principal: input.principal,
          email: input.email,
          wechat: input.wechat,
          miniProgramId: input.miniProgramId,
          address: input.address,
          notes: input.notes,
          duplicateDecision: input.duplicateDecision,
          dryRun: true,
        });
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "客户申请" });
      }

      // If there are blocking duplicates, do NOT throw - still create the
      // PENDING proposal so the card can display candidates and require
      // explicit user override via PATCH.
      const hasDuplicates = result.blockingDuplicates && result.blockingDuplicates.length > 0;
      const requiresOverride = hasDuplicates && !input.duplicateDecision;

      // Store privacy-safe candidates in proposalInput for the card to display
      const proposalInput: Record<string, unknown> = { ...input };
      if (hasDuplicates) {
        proposalInput.duplicateCandidates = result.blockingDuplicates.map((c) => ({
          id: c.id,
          name: c.name,
          customerCodeLast6: c.customerCodeLast6,
          organization: c.organization,
          matchReasons: c.matchReasons,
        }));
        proposalInput.requiresDuplicateOverride = true;
      }

      return {
        title: `新增客户申请：${input.name}`,
        summary: requiresOverride
          ? `检测到可能重复的客户，需要你确认是否仍然新建「${input.name}」。`
          : `将创建客户「${input.name}」并进入主管复核队列。`,
        proposalInput,
      };
    },
    async execute(ctx, input) {
      const businessActor = ctx.actor;
const { invocation } = ctx;
      try {
        // Re-run duplicate detection before actual creation. If blocking
        // duplicates still exist and the user has NOT explicitly overridden
        // (via PATCH), refuse to execute.
        const checkResult = await submitCustomerApplicationForActor(businessActor, invocation, {
          name: input.name,
          organizationId: input.organizationId,
          organizationSiteId: input.organizationSiteId,
          principal: input.principal,
          email: input.email,
          wechat: input.wechat,
          miniProgramId: input.miniProgramId,
          address: input.address,
          notes: input.notes,
          duplicateDecision: input.duplicateDecision,
          dryRun: true,
        });

        if (
          checkResult.blockingDuplicates &&
          checkResult.blockingDuplicates.length > 0 &&
          input.duplicateDecision !== "CREATE_NEW"
        ) {
          throw new AgentActionForbiddenError(
            "检测到重复客户，需要用户显式确认仍然新建后才能提交",
          );
        }

        const result = await submitCustomerApplicationForActor(businessActor, invocation, {
          name: input.name,
          organizationId: input.organizationId,
          organizationSiteId: input.organizationSiteId,
          principal: input.principal,
          email: input.email,
          wechat: input.wechat,
          miniProgramId: input.miniProgramId,
          address: input.address,
          notes: input.notes,
          duplicateDecision: input.duplicateDecision,
        });

        return {
          application: {
            id: result.application.id,
            status: result.application.status,
            supervisorReviewStatus: result.application.supervisorReviewStatus,
          },
          profileId: result.profileId,
          duplicateCandidates: [],
        };
      } catch (err) {
        if (err instanceof AgentActionForbiddenError) {
          throw err;
        }
        mapDomainErrorToAgentError(err, { resourceLabel: "客户申请" });
      }
    },
    resolveTarget(_input, output) {
      return { type: "crm_customer_application", id: output.application.id };
    },
  });

  // ---- crm.list_my_customer_applications ----
  registerAgentAction({
    key: "crm.list_my_customer_applications",
    title: "查看我的客户申请",
    description: "查看当前用户提交的客户申请状态。",
    domain: "crm",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      items: arraySchema(objectSchema({
        id: stringSchema(),
        name: stringSchema(),
        status: stringSchema(),
        supervisorReviewStatus: stringSchema(),
        createdAt: stringSchema(),
      })),
    }),
    presentation: { type: "card", narration: "minimal" },
    parseInput(raw) {
      ensureObject(raw);
      return {};
    },
    async availability(actor) {
      return canUseCrmAgent(actor.role);
    },
    async execute(ctx) {
      return mapQueryError(() =>
        listMyCustomerApplicationsForActor(ctx.actor, { limit: 20 }),
      );
    },
  });
}
