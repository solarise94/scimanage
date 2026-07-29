import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30000,
    // fork worker 之间进程/env/globalThis 隔离；单 worker 内仍按文件顺序执行。
    // 配合 schema 模板 + COW 临时库，4 worker 可降低总耗时且不会共享 SQLite。
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 4,
    // 成功测试的业务日志不写终端；失败用例仍完整输出，减少 CI/本地 I/O。
    silent: "passed-only",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
