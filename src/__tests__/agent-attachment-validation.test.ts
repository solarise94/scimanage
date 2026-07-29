/**
 * P0/P1 通用附件服务端校验与私有存储根测试（设计 §7.2.3 / §4.2）。
 * 直接导入生产模块；纯函数，无需 prisma。
 */
import { describe, expect, it } from "vitest";
import { StagingError } from "@/lib/staging-common";
import { validateAgentAttachmentPayload } from "@/lib/agent-attachments/validation";
import {
  assertNotUnderPublic,
  getAgentAttachmentStagingRoot,
  getAgentProjectAttachmentRoot,
} from "@/lib/agent-attachments/storage";
import {
  allowedRoutesForMime,
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
} from "@/lib/agent-attachments/constants";
import path from "path";

function pngBuffer(extra = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 0x01),
  ]);
}
function jpegBuffer(extra = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 0x02)]);
}
function webpBuffer(extra = 64): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
    Buffer.alloc(extra, 0x03),
  ]);
}
function pdfBuffer(): Buffer {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");
}

describe("validateAgentAttachmentPayload（白名单 + magic/MIME/扩展名一致 + 大小）", () => {
  it("accepts a valid PNG", () => {
    const r = validateAgentAttachmentPayload({
      originalFileName: "shot.png",
      declaredMime: "image/png",
      buffer: pngBuffer(),
    });
    expect(r.mimeType).toBe("image/png");
    expect(r.ext).toBe(".png");
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts JPEG and WebP and PDF", () => {
    expect(validateAgentAttachmentPayload({ originalFileName: "a.jpg", declaredMime: "image/jpeg", buffer: jpegBuffer() }).mimeType).toBe("image/jpeg");
    expect(validateAgentAttachmentPayload({ originalFileName: "a.webp", declaredMime: "image/webp", buffer: webpBuffer() }).mimeType).toBe("image/webp");
    expect(validateAgentAttachmentPayload({ originalFileName: "a.pdf", declaredMime: "application/pdf", buffer: pdfBuffer() }).mimeType).toBe("application/pdf");
  });

  it("rejects empty file", () => {
    expect(() =>
      validateAgentAttachmentPayload({ originalFileName: "x.png", declaredMime: "image/png", buffer: Buffer.alloc(0) }),
    ).toThrow(StagingError);
  });

  it("rejects SVG content disguised as .png (magic mismatch)", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8");
    expect(() =>
      validateAgentAttachmentPayload({ originalFileName: "evil.png", declaredMime: "image/png", buffer: svg }),
    ).toThrow(StagingError);
  });

  it("rejects HTML by extension", () => {
    const html = Buffer.from("<html><body>hi</body></html>", "utf8");
    expect(() =>
      validateAgentAttachmentPayload({ originalFileName: "page.html", declaredMime: "text/html", buffer: html }),
    ).toThrow(StagingError);
  });

  it("rejects double extension ending in .exe", () => {
    expect(() =>
      validateAgentAttachmentPayload({ originalFileName: "report.pdf.exe", declaredMime: "application/pdf", buffer: pdfBuffer() }),
    ).toThrow(StagingError);
  });

  it("rejects extension/content mismatch (.png name, PDF content)", () => {
    expect(() =>
      validateAgentAttachmentPayload({ originalFileName: "fake.png", declaredMime: "image/png", buffer: pdfBuffer() }),
    ).toThrow(StagingError);
  });

  it("rejects OOXML extension with non-zip content (.xlsx name, PNG content)", () => {
    expect(() =>
      validateAgentAttachmentPayload({
        originalFileName: "data.xlsx",
        declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: pngBuffer(),
      }),
    ).toThrow(StagingError);
  });

  it("rejects text file exceeding 2 MB", () => {
    const big = Buffer.concat([Buffer.from("a", "ascii"), Buffer.alloc(2 * 1024 * 1024 + 10, 0x61)]);
    expect(() =>
      validateAgentAttachmentPayload({ originalFileName: "big.txt", declaredMime: "text/plain", buffer: big }),
    ).toThrow(StagingError);
  });

  it("rejects a binary file named .txt (NUL byte)", () => {
    const bin = Buffer.concat([Buffer.from("x", "ascii"), Buffer.from([0x00, 0x01, 0x02])]);
    expect(() =>
      validateAgentAttachmentPayload({ originalFileName: "b.txt", declaredMime: "text/plain", buffer: bin }),
    ).toThrow(StagingError);
  });
});

describe("私有存储根隔离（§4.2）", () => {
  it("staging 与项目附件根目录都不在 public/ 下且互不相同", () => {
    const staging = getAgentAttachmentStagingRoot();
    const project = getAgentProjectAttachmentRoot();
    const publicRoot = path.resolve(process.cwd(), "public");
    expect(staging.startsWith(publicRoot)).toBe(false);
    expect(project.startsWith(publicRoot)).toBe(false);
    expect(staging).not.toBe(project);
  });

  it("assertNotUnderPublic 拒绝 public/ 路径", () => {
    expect(() => assertNotUnderPublic(path.resolve(process.cwd(), "public/uploads/x.png"))).toThrow(StagingError);
    expect(() => assertNotUnderPublic(getAgentProjectAttachmentRoot())).not.toThrow();
  });
});

describe("allowedRoutes 仅由真实 MIME 计算（§6.3.1）", () => {
  it("PDF/JPEG/PNG 可路由发票 + 项目备注", () => {
    expect(allowedRoutesForMime("application/pdf")).toEqual(["INVOICE_STAGING", "PROJECT_NOTE"]);
    expect(allowedRoutesForMime("image/jpeg")).toEqual(["INVOICE_STAGING", "PROJECT_NOTE"]);
    expect(allowedRoutesForMime("image/png")).toEqual(["INVOICE_STAGING", "PROJECT_NOTE"]);
  });
  it("WebP/TXT/CSV/DOCX/XLSX 只能项目备注", () => {
    expect(allowedRoutesForMime("image/webp")).toEqual(["PROJECT_NOTE"]);
    expect(allowedRoutesForMime("text/plain")).toEqual(["PROJECT_NOTE"]);
    expect(allowedRoutesForMime("text/csv")).toEqual(["PROJECT_NOTE"]);
    expect(allowedRoutesForMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toEqual(["PROJECT_NOTE"]);
  });
  it("未知 MIME 无路由", () => {
    expect(allowedRoutesForMime("image/svg+xml")).toEqual([]);
  });
  it("默认纯附件消息文本为集中常量", () => {
    expect(DEFAULT_ATTACHMENT_ONLY_MESSAGE.length).toBeGreaterThan(0);
  });
});
