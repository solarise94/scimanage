import path from "path";

/**
 * 合同附件文件根目录。默认 `public/uploads/contracts`；可用环境变量
 * `SCIMANAGE_CONTRACT_UPLOADS_DIR` 注入（测试用进程专属临时目录，使测试
 * 永不触碰真实 uploads——清理整目录也安全）。运行时读取 env，测试只需
 * 在调用任何生成/恢复/下载函数之前设置；生产默认值与行为不变。
 *
 * generate（写入）、recovery（恢复/孤儿清理）、download route（读取）
 * 必须共用本模块，保证三处对「文件在哪」的解析永远一致。
 */
export function contractsUploadRoot(): string {
  return (
    process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR ??
    path.join(process.cwd(), "public", "uploads", "contracts")
  );
}

/**
 * 把合同文件的公共 URL（DB 里的 fileUrl，形如
 * `/uploads/contracts/<contractId>/<file>.docx`）解析为文件系统绝对路径。
 * `/uploads/contracts/` 前缀映射到注入根；其余回退 public/（历史附件）。
 * 拒绝路径逃逸：解析结果必须仍在对应根目录内。
 */
export function resolveContractFilePath(fileUrl: string): string {
  const rel = fileUrl.replace(/^\/+/, "");
  const contractPrefix = "uploads/contracts/";
  if (rel.startsWith(contractPrefix)) {
    const root = path.resolve(contractsUploadRoot());
    const abs = path.resolve(root, rel.slice(contractPrefix.length));
    if (!abs.startsWith(root + path.sep)) {
      throw new Error("invalid contract file path");
    }
    return abs;
  }
  const publicRoot = path.resolve(process.cwd(), "public");
  const abs = path.resolve(publicRoot, rel);
  if (!abs.startsWith(publicRoot + path.sep)) {
    throw new Error("invalid contract file path");
  }
  return abs;
}
