import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";
import { scanSource } from "../../../../../scripts/lib/agent-boundaries-scan";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T5.4: organization binding + customer application actor-aware facades.
 */
describe("T5.4 binding/application facades", () => {
  it("enforces gates, formal writes, Agent/Web parity, and crm.ts stays Prisma-free", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { requestOrganizationBindingForActor } = await import(
        "@/lib/crm/application/request-organization-binding"
      );
      const { submitCustomerApplicationForActor } = await import(
        "@/lib/crm/application/submit-customer-application"
      );
      const { ForbiddenError } = await import("@/lib/application/errors");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const webInvocation = buildInvocationContext({ channel: "web" });
      const agentInvocation = buildInvocationContext({ channel: "agent" });

      const admin = await prisma.user.create({
        data: { email: "t54-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repUser = await prisma.user.create({
        data: {
          email: "t54-rep@example.com",
          name: "Rep",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const rmUser = await prisma.user.create({
        data: {
          email: "t54-rm@example.com",
          name: "RM",
          password: "h",
          role: "REGIONAL_MANAGER",
        },
      });
      const plainUser = await prisma.user.create({
        data: {
          email: "t54-user@example.com",
          name: "User",
          password: "h",
          role: "USER",
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: admin.name, email: admin.email };
      const repActor = {
        userId: repUser.id,
        role: "REPRESENTATIVE",
        email: repUser.email,
        name: repUser.name,
      };
      const rmActor = {
        userId: rmUser.id,
        role: "REGIONAL_MANAGER",
        email: rmUser.email,
        name: rmUser.name,
      };
      const plainActor = {
        userId: plainUser.id,
        role: "USER",
        email: plainUser.email,
        name: plainUser.name,
      };

      const rep = await prisma.representative.create({
        data: { name: "代表T54", email: repUser.email },
      });
      await prisma.representative.create({
        data: { name: "Admin代表", email: admin.email },
      });
      await prisma.representative.create({
        data: { name: "RM代表", email: rmUser.email },
      });

      const orgBound = await prisma.organization.create({
        data: {
          orgCode: "T54-BOUND",
          canonicalName: "T54已绑定医院",
          normalizedName: "t54已绑定医院",
          isInvoiceSubject: true,
        },
      });
      const orgUnbound = await prisma.organization.create({
        data: {
          orgCode: "T54-UNBOUND",
          canonicalName: "T54待绑定医院",
          normalizedName: "t54待绑定医院",
        },
      });
      const orgForAgent = await prisma.organization.create({
        data: {
          orgCode: "T54-AGENT",
          canonicalName: "T54 Agent绑定医院",
          normalizedName: "t54agent绑定医院",
        },
      });

      await prisma.representativeOrganization.create({
        data: {
          representativeId: rep.id,
          organizationId: orgBound.id,
          status: "ACTIVE",
          isPrimary: true,
          source: "MANUAL",
        },
      });

      // Gates: web submit rejects plain USER
      await expect(
        submitCustomerApplicationForActor(plainActor, webInvocation, {
          name: "新客户",
          organizationId: orgBound.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Gates: agent channel rejects RM on binding
      await expect(
        requestOrganizationBindingForActor(rmActor, agentInvocation, {
          organizationId: orgUnbound.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Formal write: org binding self-service → PENDING
      const binding = await requestOrganizationBindingForActor(repActor, webInvocation, {
        organizationId: orgUnbound.id,
      });
      expect(binding.binding.status).toBe("PENDING");
      expect(binding.binding.organizationId).toBe(orgUnbound.id);
      expect(binding.isNewOrg).toBe(false);

      const bindingRow = await prisma.representativeOrganization.findUnique({
        where: { id: binding.binding.id },
      });
      expect(bindingRow?.status).toBe("PENDING");

      // Formal write: customer application → profile + APPROVED application
      const appResult = await submitCustomerApplicationForActor(repActor, webInvocation, {
        name: "T54新客户",
        organizationId: orgBound.id,
        principal: "张教授",
      });
      expect(appResult.application.status).toBe("APPROVED");
      expect(appResult.profileId).toBeTruthy();
      expect(appResult.blockingDuplicates).toHaveLength(0);

      const createdProfile = await prisma.crmCustomerProfile.findUnique({
        where: { id: appResult.profileId },
      });
      expect(createdProfile?.name).toBe("T54新客户");

      // Agent parity: org binding (ADMIN still PENDING on self-service facade path)
      const agentBinding = await executeAgentAction<{
        binding: { id: string; status: string; organizationName: string };
        isNewOrg: string;
      }>(
        agentExecCtx(adminActor),
        "crm.request_organization_binding",
        { organizationId: orgForAgent.id },
        { allowConfirm: true },
      );
      expect(agentBinding.result.binding.status).toBe("PENDING");

      // Agent parity: customer application
      const agentApp = await executeAgentAction<{
        application: { id: string; status: string };
        profileId: string;
      }>(
        agentExecCtx(repActor),
        "crm.submit_customer_application",
        {
          name: "T54 Agent客户",
          organizationId: orgBound.id,
        },
        { allowConfirm: true },
      );
      expect(agentApp.result.application.status).toBe("APPROVED");
      expect(agentApp.result.profileId).toBeTruthy();

      // crm.ts adapter must stay Prisma-free
      const repoRoot = join(process.cwd());
      const crmSource = readFileSync(
        join(repoRoot, "src/lib/agent-actions/actions/crm.ts"),
        "utf8",
      );
      const findings = scanSource("src/lib/agent-actions/actions/crm.ts", crmSource);
      expect(findings.some((f) => f.kind === "prisma-import")).toBe(false);
      expect(findings.some((f) => f.kind === "prisma-call")).toBe(false);
      expect(findings.some((f) => f.kind === "tx-model")).toBe(false);
    });
  }, 120_000);
});
