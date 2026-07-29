/**
 * Backfill OrganizationSite 经纬度（Task 1.14）
 *
 * 遍历未定位（lat IS NULL）且未归档的 OrganizationSite，逐个调用高德 geocodeSite()，
 * 把结果写回 lat / lng / geocodeSource / geocodedAt / geocodeRawJson。
 *
 *  - 幂等：只处理 lat IS NULL 的 site；已定位的跳过。修正后重跑只补仍未定位的。
 *  - 限速：默认每秒约 3 个（RATE_PER_SEC 可调），用 sleep 串行化（site-geocode.ts 不做
 *    模块级限速，限速只在这里做）。
 *  - 失败重试：每个 site 最多重试 MAX_RETRY 次（默认 2），短退避。
 *  - 撞配额/限频：连续失败超过 ABORT_AFTER_CONSEC_FAIL（默认 10）个 site 时，判定疑似
 *    日配额耗尽，提前中止并打印剩余数量；幂等，稍后重跑即可续上。
 *
 * 这是手动运维脚本，不进 cron。用 tsx 运行（参考 prisma/seed.ts 模式；DATABASE_URL 与
 * AMAP_WEB_KEY 由 .env 自动加载）。
 *
 * 用法：
 *   # 仅扫描（dry-run，默认；不调高德、不写库，只列出待回填 site）
 *   npx tsx scripts/backfill-site-geocode.ts
 *
 *   # 实际回填
 *   WRITE=1 npx tsx scripts/backfill-site-geocode.ts
 *
 *   # 限制本次处理数量（测试 / 控制配额消耗）
 *   WRITE=1 LIMIT=50 npx tsx scripts/backfill-site-geocode.ts
 *
 *   # 调整限速
 *   WRITE=1 RATE_PER_SEC=2 npx tsx scripts/backfill-site-geocode.ts
 */
import { prisma } from "../src/lib/prisma";
import { geocodeSite } from "../src/lib/site-geocode";

const WRITE = process.env.WRITE === "1";
const RATE_PER_SEC = Number(process.env.RATE_PER_SEC) > 0 ? Number(process.env.RATE_PER_SEC) : 3;
const MIN_INTERVAL_MS = Math.ceil(1000 / RATE_PER_SEC);
const MAX_RETRY = Number.isFinite(Number(process.env.MAX_RETRY)) && Number(process.env.MAX_RETRY) >= 0
  ? Number(process.env.MAX_RETRY)
  : 2;
const LIMIT = Number(process.env.LIMIT) > 0 ? Number(process.env.LIMIT) : Infinity;
const ABORT_AFTER_CONSEC_FAIL = Number(process.env.ABORT_AFTER_CONSEC_FAIL) > 0
  ? Number(process.env.ABORT_AFTER_CONSEC_FAIL)
  : 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(
    `[backfill-site-geocode] mode=${WRITE ? "WRITE" : "DRY-RUN"} rate=${RATE_PER_SEC}/s retry=${MAX_RETRY}` +
    `${LIMIT !== Infinity ? ` limit=${LIMIT}` : ""} abortAfterConsecFail=${ABORT_AFTER_CONSEC_FAIL}`,
  );

  if (WRITE && !process.env.AMAP_WEB_KEY) {
    console.error("AMAP_WEB_KEY 未配置，无法地理编码。中止。");
    process.exit(1);
  }

  // 只处理未定位（lat IS NULL）且未归档的 site。归档的 site 治理上无需定位。
  const sites = await prisma.organizationSite.findMany({
    where: { lat: null, archived: false },
    select: {
      id: true,
      siteName: true,
      organization: { select: { canonicalName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const targets = LIMIT === Infinity ? sites : sites.slice(0, LIMIT);

  console.log(
    `未定位 site 总数: ${sites.length}` +
    `${targets.length !== sites.length ? `（本次处理前 ${targets.length} 个）` : ""}`,
  );
  if (targets.length === 0) {
    console.log("没有需要回填的 site。");
    return;
  }

  if (!WRITE) {
    console.log("\n(DRY-RUN) 将地理编码以下 site（不调高德、不写库）：");
    for (const s of targets.slice(0, 50)) {
      console.log(`  siteId=${s.id} "${s.siteName}" @ ${s.organization.canonicalName}`);
    }
    if (targets.length > 50) console.log(`  ... 以及另外 ${targets.length - 50} 个`);
    console.log("\n加 WRITE=1 实际执行。");
    return;
  }

  let ok = 0;
  const failed: Array<{ id: string; siteName: string; reason: string }> = [];
  let consecutiveFail = 0;
  let aborted = false;
  let processed = 0;

  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    const startedAt = Date.now();
    let settled = false;
    let lastReason = "未知错误";

    for (let attempt = 0; attempt <= MAX_RETRY && !settled; attempt++) {
      const { error, result } = await geocodeSite(s.siteName);
      if (result && Number.isFinite(result.lat) && Number.isFinite(result.lng)) {
        await prisma.organizationSite.update({
          where: { id: s.id },
          data: {
            lat: result.lat,
            lng: result.lng,
            geocodeSource: result.source, // POI_SEARCH | GEOCODE
            geocodedAt: new Date(),
            geocodeRawJson: result.raw,
          },
        });
        ok++;
        consecutiveFail = 0;
        settled = true;
        console.log(
          `  [${i + 1}/${targets.length}] ✓ ${s.siteName} → ` +
          `${result.lng.toFixed(6)},${result.lat.toFixed(6)} (${result.source})`,
        );
      } else {
        lastReason = error || "未返回坐标";
        if (attempt < MAX_RETRY) {
          await sleep(300 * (attempt + 1)); // 短退避后重试
        }
      }
    }

    if (!settled) {
      failed.push({ id: s.id, siteName: s.siteName, reason: lastReason });
      consecutiveFail++;
      console.warn(`  [${i + 1}/${targets.length}] ✗ ${s.siteName}: ${lastReason}`);
    }
    processed++;

    // 连续失败过多 → 疑似日配额耗尽 / 服务异常，提前中止（幂等，重跑续上）
    if (consecutiveFail >= ABORT_AFTER_CONSEC_FAIL) {
      console.error(
        `\n连续 ${consecutiveFail} 个 site 失败，疑似撞高德配额或服务异常，提前中止。` +
        `剩余 ${targets.length - processed} 个未处理，修正后重跑即可（幂等）。`,
      );
      aborted = true;
      break;
    }

    // 限速：保证相邻两次调用间隔 ≥ MIN_INTERVAL_MS
    const elapsed = Date.now() - startedAt;
    if (i < targets.length - 1 && elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
  }

  console.log(`\n完成。成功 ${ok}，失败 ${failed.length}，已处理 ${processed}/${targets.length}${aborted ? "（提前中止）" : ""}。`);
  if (failed.length > 0) {
    console.log("失败列表：");
    for (const f of failed) console.log(`  siteId=${f.id} "${f.siteName}" — ${f.reason}`);
    console.log("\n（幂等）修正后重跑只会处理仍未定位的 site。");
  }
}

main()
  .catch((err) => {
    console.error("[backfill-site-geocode] Failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
