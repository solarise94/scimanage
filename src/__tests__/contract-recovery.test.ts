/**
 * 契约测试：合同 PENDING_FILE 恢复状态机
 * 覆盖 tmp/staging/final 混合状态、rename 重试、TTL 过滤、清理逻辑。
 *
 * 使用真实文件系统（os.tmpdir）模拟合同目录，mock Prisma 调用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Mock prisma（$transaction 自引用：tx 复用 prisma mock 方法，断言不变）
vi.mock("@/lib/prisma", () => {
  const prismaMock = {
    contractDocument: {
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
    },
    contractAttachment: { deleteMany: vi.fn() },
    orderContractCoverage: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock)),
  };
  return { prisma: prismaMock };
});

import { resumePendingFileContracts } from "@/lib/contracts/generate";
import { prisma } from "@/lib/prisma";

const mockPrisma = vi.mocked(prisma, true);
let testDir: string;
let contractsDir: string;

const CONTRACT_ID = "ct_test_001";
const CONTRACT_NO = "HT-20260101-ABC";

type PendingContractRow = {
  id: string;
  contractNo: string;
  createdAt: Date;
  generationIntentId?: string | null;
};

function pendingContract(overrides?: Partial<PendingContractRow>): PendingContractRow {
  return {
    id: CONTRACT_ID,
    contractNo: CONTRACT_NO,
    createdAt: new Date(0),
    generationIntentId: null,
    ...overrides,
  };
}

/** Prisma mock 返回值用 never 收窄，避免测试里散落 any。 */
function mockResolve<T>(value: T): never {
  return value as never;
}

async function setupContractDir(fileStates: {
  docx?: "tmp" | "staging" | "final" | "none";
  snapshot?: "tmp" | "staging" | "final" | "none";
}) {
  const dir = path.join(contractsDir, CONTRACT_ID);
  await fs.mkdir(dir, { recursive: true });

  const docxFileName = `${CONTRACT_NO}.docx`;
  const finalDocx = path.join(dir, docxFileName);
  const finalSnapshot = path.join(dir, "template-snapshot.docx");
  const tmpDocx = path.join(dir, `.tmp-${CONTRACT_ID}.docx`);
  const tmpSnapshot = path.join(dir, ".tmp-template-snapshot.docx");
  const stagingDocx = `${finalDocx}.staging`;
  const stagingSnapshot = `${finalSnapshot}.staging`;

  const place = async (
    state: "tmp" | "staging" | "final" | "none",
    paths: { tmp: string; staging: string; final: string },
  ) => {
    if (state === "tmp") await fs.writeFile(paths.tmp, "tmp-content");
    else if (state === "staging") await fs.writeFile(paths.staging, "staging-content");
    else if (state === "final") await fs.writeFile(paths.final, "final-content");
  };

  await place(fileStates.docx ?? "none", { tmp: tmpDocx, staging: stagingDocx, final: finalDocx });
  await place(fileStates.snapshot ?? "none", {
    tmp: tmpSnapshot,
    staging: stagingSnapshot,
    final: finalSnapshot,
  });

  return { dir, finalDocx, finalSnapshot, tmpDocx, tmpSnapshot, stagingDocx, stagingSnapshot };
}

beforeEach(async () => {
  vi.clearAllMocks();
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(testDir);
  contractsDir = path.join(testDir, "public", "uploads", "contracts");
  await fs.mkdir(contractsDir, { recursive: true });

  mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([]));
  mockPrisma.contractDocument.update.mockResolvedValue(mockResolve(pendingContract()));
  mockPrisma.contractDocument.delete.mockResolvedValue(mockResolve(pendingContract()));
  mockPrisma.contractDocument.findUnique.mockResolvedValue(mockResolve(null));
  mockPrisma.contractAttachment.deleteMany.mockResolvedValue(mockResolve({ count: 0 }));
  mockPrisma.orderContractCoverage.deleteMany.mockResolvedValue(mockResolve({ count: 0 }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

describe("resumePendingFileContracts", () => {
  it("returns zero results when no pending contracts", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([]));
    const result = await resumePendingFileContracts();
    expect(result).toEqual({ resumed: 0, cleaned: 0, skipped: 0 });
  });

  it("marks GENERATED when both final files exist", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    await setupContractDir({ docx: "final", snapshot: "final" });

    const result = await resumePendingFileContracts();
    expect(result.resumed).toBe(1);
    expect(mockPrisma.contractDocument.update).toHaveBeenCalledWith({
      where: { id: CONTRACT_ID },
      data: { status: "GENERATED" },
    });
  });

  it("advances from tmp to final when both tmp files exist", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    const paths = await setupContractDir({ docx: "tmp", snapshot: "tmp" });

    const result = await resumePendingFileContracts();
    expect(result.resumed).toBe(1);
    expect(await fs.access(paths.finalDocx).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(paths.finalSnapshot).then(() => true).catch(() => false)).toBe(true);
  });

  it("advances from staging to final when both staging files exist", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    const paths = await setupContractDir({ docx: "staging", snapshot: "staging" });

    const result = await resumePendingFileContracts();
    expect(result.resumed).toBe(1);
    expect(await fs.access(paths.finalDocx).then(() => true).catch(() => false)).toBe(true);
  });

  it("resumes mixed state: docx final + snapshot tmp", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    const paths = await setupContractDir({ docx: "final", snapshot: "tmp" });

    const result = await resumePendingFileContracts();
    expect(result.resumed).toBe(1);
    expect(await fs.access(paths.finalSnapshot).then(() => true).catch(() => false)).toBe(true);
  });

  it("cleans stale tmp file when final already exists", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    const paths = await setupContractDir({ docx: "final", snapshot: "final" });
    await fs.writeFile(paths.tmpDocx, "stale");
    await fs.writeFile(paths.tmpSnapshot, "stale");

    await resumePendingFileContracts();
    expect(await fs.access(paths.tmpDocx).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(paths.tmpSnapshot).then(() => true).catch(() => false)).toBe(false);
  });

  it("cleans DB and files when no files exist", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    await setupContractDir({ docx: "none", snapshot: "none" });

    const result = await resumePendingFileContracts();
    expect(result.cleaned).toBe(1);
    expect(mockPrisma.contractDocument.delete).toHaveBeenCalledWith({ where: { id: CONTRACT_ID } });
  });

  it("skips when only one file exists (partial state)", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    await setupContractDir({ docx: "tmp", snapshot: "none" });

    const result = await resumePendingFileContracts();
    expect(result.skipped).toBe(1);
    expect(result.resumed).toBe(0);
    expect(result.cleaned).toBe(0);
    expect(mockPrisma.contractDocument.update).not.toHaveBeenCalled();
    expect(mockPrisma.contractDocument.delete).not.toHaveBeenCalled();
  });

  it("filters by TTL (only processes old records)", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([]));

    await resumePendingFileContracts();

    const callArg = mockPrisma.contractDocument.findMany.mock.calls[0]?.[0] as
      | { where: { status: string; createdAt: { lt: Date } } }
      | undefined;
    expect(callArg).toBeDefined();
    expect(callArg!.where.status).toBe("PENDING_FILE");
    expect(callArg!.where.createdAt.lt).toBeInstanceOf(Date);
  });

  it("cleans orphan directories with ct_ prefix older than 1 hour", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([]));
    mockPrisma.contractDocument.findUnique.mockResolvedValue(mockResolve(null));

    const orphanDir = path.join(contractsDir, "ct_orphan_old");
    await fs.mkdir(orphanDir, { recursive: true });
    await fs.writeFile(path.join(orphanDir, "junk"), "junk");
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(orphanDir, oldTime, oldTime);

    const recentOrphanDir = path.join(contractsDir, "ct_orphan_recent");
    await fs.mkdir(recentOrphanDir, { recursive: true });

    const otherDir = path.join(contractsDir, "some_other_dir");
    await fs.mkdir(otherDir, { recursive: true });

    const result = await resumePendingFileContracts();
    expect(result.cleaned).toBeGreaterThanOrEqual(1);
    expect(await fs.access(orphanDir).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(recentOrphanDir).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(otherDir).then(() => true).catch(() => false)).toBe(true);
  });

  it("resumes interleaved state: docx staging + snapshot tmp", async () => {
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([pendingContract()]));

    const dir = path.join(contractsDir, CONTRACT_ID);
    await fs.mkdir(dir, { recursive: true });
    const docxFileName = `${CONTRACT_NO}.docx`;
    const finalDocx = path.join(dir, docxFileName);
    const finalSnapshot = path.join(dir, "template-snapshot.docx");
    const tmpSnapshot = path.join(dir, ".tmp-template-snapshot.docx");
    const stagingDocx = `${finalDocx}.staging`;

    await fs.writeFile(stagingDocx, "staging-docx");
    await fs.writeFile(tmpSnapshot, "tmp-snapshot");

    const result = await resumePendingFileContracts();
    expect(result.resumed).toBe(1);
    expect(await fs.access(finalDocx).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(finalSnapshot).then(() => true).catch(() => false)).toBe(true);
  });

  it("keeps PENDING_FILE when rename throws, then resumes on next run", async () => {
    const contract = pendingContract();
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([contract]));

    const paths = await setupContractDir({ docx: "tmp", snapshot: "tmp" });

    const originalRename = fs.rename;
    let renameCallCount = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      renameCallCount++;
      if (renameCallCount === 1) throw new Error("simulated EIO");
      return originalRename(...args);
    });

    let result1 = await resumePendingFileContracts();
    expect(result1.skipped).toBe(1);
    expect(result1.resumed).toBe(0);
    expect(mockPrisma.contractDocument.update).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
    mockPrisma.contractDocument.findMany.mockResolvedValue(mockResolve([contract]));
    mockPrisma.contractDocument.update.mockResolvedValue(mockResolve(contract));
    mockPrisma.contractDocument.findUnique.mockResolvedValue(mockResolve(null));

    result1 = await resumePendingFileContracts();
    expect(result1.resumed).toBe(1);
    expect(await fs.access(paths.finalDocx).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(paths.finalSnapshot).then(() => true).catch(() => false)).toBe(true);
  });
});
