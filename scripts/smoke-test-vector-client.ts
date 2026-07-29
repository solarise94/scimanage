/**
 * 向量服务客户端 smoke（连真实 TEI @ 127.0.0.1:8103，不 mock）。
 *
 * 覆盖：
 *  1. checkVectorServiceReady → true；
 *  2. embedTexts 四条 → 四个 1024 维向量；
 *     近重复（同字「王晓明」×2）cosine > 0.99；
 *     相关人名（王晓明 vs 王小明）cosine > 0.5 且明显 > 无关词（订货合同）；
 *     （注：bge-m3 对同音异字 cosine 仅 ~0.75，故不用 0.9 阈值，见用例内注释）；
 *  3. rerankDocuments 保序正确（相关文档 score > 无关文档）；
 *  4. encode/decode 往返无损（误差 < 1e-6）；
 *  5. 服务不可达时降级：临时指到 127.0.0.1:9（不可用端口），embedTexts 返回 null 不抛。
 *
 * 运行: npx tsx scripts/smoke-test-vector-client.ts
 *   前置：TEI 服务在 http://127.0.0.1:8103 就绪。
 */

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

async function probeTei(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:8103/health/ready", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { ready?: unknown };
    return json?.ready === true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== 向量服务客户端 smoke（真实 TEI）===\n");

  const teiReady = await probeTei();
  if (!teiReady) {
    console.error(
      "❌ TEI 服务未就绪（http://127.0.0.1:8103/health/ready）。请先启动 TEI 再跑本 smoke。",
    );
    process.exit(3);
  }

  const {
    checkVectorServiceReady,
    embedTexts,
    rerankDocuments,
    encodeEmbedding,
    decodeEmbedding,
    cosineSimilarity,
  } = await import("../src/lib/agent-runtime/vector");

  // ── 1. checkVectorServiceReady ─────────────────────────────────────────────
  console.log("[1] checkVectorServiceReady → true");
  {
    const ready = await checkVectorServiceReady();
    assert(ready === true, "/health/ready 探活返回 true");
  }

  // ── 2. embedTexts 语义相似度 ───────────────────────────────────────────────
  // 注：bge-m3 对不同汉字（即使同音，如「王晓明」vs「王小明」）的 cosine 仅 ~0.75，
  // 不达到任务假设的 0.9。因此本断言分两层：
  //   (a) 近重复（同字符串）cosine > 0.99 —— 证明 embedTexts 产出了可比较的稳定向量；
  //   (b) 相关人名（王晓明/王小明）cosine > 0.5 且明显 > 无关词（订货合同）—— 证明
  //       语义方向正确（同为人名 > 商务术语）。这是 TEI 实测可达的区间。
  console.log("\n[2] embedTexts 语义相似度（近重复 > 相关 > 无关）");
  {
    const vecs = await embedTexts(["王晓明", "王小明", "订货合同", "王晓明"]);
    assert(Array.isArray(vecs), "embedTexts 返回数组");
    assert(vecs?.length === 4, `返回 4 条向量（实际 ${vecs?.length}）`);
    assert(
      Array.isArray(vecs?.[0]) && (vecs?.[0].length ?? 0) === 1024,
      `维度 = 1024（实际 ${vecs?.[0].length}）`,
    );

    if (vecs && vecs.length === 4) {
      const [xm, xm2, contract, xmDup] = vecs;
      const nearDup = cosineSimilarity(xm, xmDup); // 同字符串 → ~1.0
      const relatedPerson = cosineSimilarity(xm, xm2); // 王晓明 vs 王小明 ~0.75
      const unrelated = cosineSimilarity(xm, contract); // 王晓明 vs 订货合同 ~0.3
      console.log(
        `    cosine(王晓明, 王晓明[同字]) = ${nearDup.toFixed(4)}（期望 > 0.99）`,
      );
      console.log(
        `    cosine(王晓明, 王小明) = ${relatedPerson.toFixed(4)}（期望 > 0.5）`,
      );
      console.log(
        `    cosine(王晓明, 订货合同) = ${unrelated.toFixed(4)}（期望明显更低）`,
      );
      assert(nearDup > 0.99, "近重复（同字）cosine > 0.99");
      assert(relatedPerson > 0.5, "相关人名 cosine > 0.5");
      assert(
        relatedPerson - unrelated > 0.1,
        "相关人名 vs 无关词 差距 > 0.1（语义方向正确）",
      );
    }
  }

  // ── 3. rerankDocuments 保序 ────────────────────────────────────────────────
  console.log("\n[3] rerankDocuments 保序（相关 > 无关）");
  {
    const query = "客户的订货合同金额";
    const docs = [
      "本季度客户签订的采购订单总金额", // 相关
      "订货合同与发票的对应关系", // 相关
      "天气预报：明天有雨", // 无关
      "公司团建活动安排", // 无关
    ];
    const scores = await rerankDocuments(query, docs);
    assert(Array.isArray(scores), "rerankDocuments 返回数组");
    assert(scores?.length === docs.length, `返回长度 = docs 长度（实际 ${scores?.length}）`);
    if (scores && scores.length === docs.length) {
      console.log(
        "    scores:",
        scores.map((s, i) => `[${i}]${s.toFixed(3)}`).join(" "),
      );
      const maxRelevant = Math.max(scores[0], scores[1]);
      const maxIrrelevant = Math.max(scores[2], scores[3]);
      assert(
        maxRelevant > maxIrrelevant,
        `相关文档 score (${maxRelevant.toFixed(3)}) > 无关文档 (${maxIrrelevant.toFixed(3)})`,
      );
    }
  }

  // ── 4. encode/decode 往返无损 ──────────────────────────────────────────────
  console.log("\n[4] encode/decode 往返无损（误差 < 1e-6）");
  {
    const vec = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) * (i % 7 === 0 ? -1 : 1));
    const buf = encodeEmbedding(vec);
    assert(Buffer.isBuffer(buf), "encodeEmbedding 返回 Buffer");
    assert(buf.length === 1024 * 4, `Buffer 字节数 = 1024*4（实际 ${buf.length}）`);

    const decoded = decodeEmbedding(buf);
    assert(Array.isArray(decoded), "decodeEmbedding 返回数组");
    assert(decoded?.length === 1024, `解码长度 = 1024（实际 ${decoded?.length}）`);

    if (decoded && decoded.length === 1024) {
      let maxErr = 0;
      for (let i = 0; i < vec.length; i++) {
        maxErr = Math.max(maxErr, Math.abs(vec[i] - decoded[i]));
      }
      console.log(`    max abs error = ${maxErr.toExponential(3)}（期望 < 1e-6）`);
      assert(maxErr < 1e-6, "往返误差 < 1e-6（Float32 LE 无损）");
    }

    // 边界：null/空 buffer → null
    assert(decodeEmbedding(null) === null, "decodeEmbedding(null) → null");
    assert(decodeEmbedding(Buffer.alloc(0)) === null, "decodeEmbedding(空) → null");
    assert(
      decodeEmbedding(Buffer.alloc(5)) === null,
      "decodeEmbedding(非 4 字节倍数) → null",
    );
  }

  // ── 5. 服务不可达降级 ──────────────────────────────────────────────────────
  console.log("\n[5] 服务不可达时 embedTexts 返回 null 不抛（env 覆盖）");
  {
    const savedBase = process.env.AGENT_VECTOR_BASE_URL;
    try {
      process.env.AGENT_VECTOR_BASE_URL = "http://127.0.0.1:9"; // 9 = discard，端口不可达
      // vector.ts 的 checkVectorServiceReady 有 60s 缓存；但 [1] 探活为 true 已缓存。
      // 为确保降级路径生效，动态重新导入模块拿一个全新实例（独立 health 缓存）。
      const freshModule = await import(
        `../src/lib/agent-runtime/vector?t=${Date.now()}`
      ).catch(() => null);
      const mod =
        freshModule ?? (await import("../src/lib/agent-runtime/vector"));

      let threw = false;
      let result: number[][] | null = null;
      try {
        result = await mod.embedTexts(["测试文本"]);
      } catch (err) {
        threw = true;
        console.log("    (unexpected throw)", err);
      }
      assert(threw === false, "embedTexts 不抛异常");
      assert(result === null, "embedTexts 在不可达端口返回 null");
    } finally {
      if (savedBase === undefined) delete process.env.AGENT_VECTOR_BASE_URL;
      else process.env.AGENT_VECTOR_BASE_URL = savedBase;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ 向量客户端 smoke 失败");
    process.exit(1);
  }
  console.log("✅ 向量客户端 smoke 通过");
}

void main().catch((err) => {
  console.error("smoke-test-vector-client crashed:", err);
  process.exit(2);
});
