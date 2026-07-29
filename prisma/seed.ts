import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import { ensureHqRepresentative } from "@/lib/crm/system-representative";

const prisma = new PrismaClient();

async function main() {
  // Clean up
  await prisma.activityLog.deleteMany();
  await prisma.statusHistory.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  // Create users
  // 所有种子账号密码均从环境变量读取，禁止在代码中硬编码。
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  if (!adminPassword) {
    throw new Error(
      "请设置 ADMIN_SEED_PASSWORD 环境变量（用于创建默认管理员种子账号，不要在代码中硬编码密码）"
    );
  }
  const user1Password = process.env.SEED_USER1_PASSWORD;
  if (!user1Password) {
    throw new Error(
      "请设置 SEED_USER1_PASSWORD 环境变量（user1@example.com 的种子密码）"
    );
  }
  const user2Password = process.env.SEED_USER2_PASSWORD;
  if (!user2Password) {
    throw new Error(
      "请设置 SEED_USER2_PASSWORD 环境变量（user2@example.com 的种子密码）"
    );
  }

  const admin = await prisma.user.create({
    data: {
      email: "admin@example.com",
      name: "admin",
      password: await hashPassword(adminPassword),
      role: "ADMIN",
    },
  });

  const user1 = await prisma.user.create({
    data: {
      email: "user1@example.com",
      name: "user1",
      password: await hashPassword(user1Password),
      role: "ADMIN",
    },
  });

  const user2 = await prisma.user.create({
    data: {
      email: "user2@example.com",
      name: "user2",
      password: await hashPassword(user2Password),
      role: "USER",
    },
  });

  // Create projects
  const project1 = await prisma.project.create({
    data: {
      name: "肺癌单细胞测序分析",
      description: "对50例肺癌患者肿瘤组织进行单细胞RNA测序，分析肿瘤微环境中的免疫细胞组成与功能状态。",
      orderNumber: "SC-2026-001",
      organization: "中科院基因组所",
      client: "协和医院",
      representative: "张研究员",
      status: "IN_PROGRESS",
      progress: 65,
      startDate: new Date("2026-01-15"),
      endDate: new Date("2026-06-30"),
      members: {
        create: [
          { userId: admin.id, role: "OWNER" },
          { userId: user1.id, role: "MEMBER" },
        ],
      },
    },
  });

  const project2 = await prisma.project.create({
    data: {
      name: "肝脏空间转录组图谱",
      description: "构建正常人肝脏的空间转录组图谱，解析肝小叶分区基因表达特征。",
      orderNumber: "SC-2026-002",
      organization: "北京大学医学部",
      client: "人民医院",
      representative: "李博士",
      status: "NOT_STARTED",
      progress: 0,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-12-31"),
      members: {
        create: [
          { userId: user2.id, role: "OWNER" },
          { userId: admin.id, role: "MEMBER" },
        ],
      },
    },
  });

  const project3 = await prisma.project.create({
    data: {
      name: "阿尔茨海默病脑组织scRNA-seq",
      description: "对比AD患者与正常对照脑组织的单细胞表达谱，寻找疾病相关的细胞亚群标志物。",
      orderNumber: "SC-2025-088",
      organization: "首都医科大学",
      client: "宣武医院",
      representative: "王教授",
      status: "COMPLETED",
      progress: 100,
      startDate: new Date("2025-06-01"),
      endDate: new Date("2026-03-15"),
      members: {
        create: [
          { userId: user1.id, role: "OWNER" },
          { userId: user2.id, role: "MEMBER" },
        ],
      },
    },
  });

  const project4 = await prisma.project.create({
    data: {
      name: "肠道微生物-宿主互作单细胞研究",
      description: "结合单细胞测序与空间转录组技术，研究肠道菌群对肠上皮细胞功能的影响。",
      orderNumber: "SC-2026-015",
      organization: "浙江大学医学院",
      client: "浙大一院",
      representative: "赵博士",
      status: "ON_HOLD",
      progress: 30,
      startDate: new Date("2026-02-01"),
      endDate: new Date("2026-08-31"),
      members: {
        create: [
          { userId: admin.id, role: "OWNER" },
        ],
      },
    },
  });

  // Create tickets
  await prisma.ticket.createMany({
    data: [
      {
        title: "样本质控未通过",
        description: "批次B的12个样本RIN值低于7，需要重新提取RNA",
        status: "OPEN",
        priority: "HIGH",
        projectId: project1.id,
        assigneeId: user1.id,
      },
      {
        title: "细胞注释参考库更新",
        description: "需要使用最新版CellTypist模型对免疫细胞进行重新注释",
        status: "IN_PROGRESS",
        priority: "MEDIUM",
        projectId: project1.id,
        assigneeId: user2.id,
      },
      {
        title: "空间转录组切片制备",
        description: "完成10张肝脏组织切片的OCT包埋与冷冻切片",
        status: "OPEN",
        priority: "URGENT",
        projectId: project2.id,
        assigneeId: admin.id,
      },
      {
        title: "数据上传至GEO",
        description: "整理AD项目原始数据并提交至NCBI GEO数据库",
        status: "CLOSED",
        priority: "MEDIUM",
        projectId: project3.id,
        assigneeId: user1.id,
      },
      {
        title: "文献综述撰写",
        description: "完成肠道微生物单细胞研究领域的文献综述",
        status: "OPEN",
        priority: "LOW",
        projectId: project4.id,
        assigneeId: user2.id,
      },
    ],
  });

  // Create comments
  await prisma.comment.createMany({
    data: [
      { content: "样本已经重新送检，预计下周拿到结果", projectId: project1.id, authorId: user1.id },
      { content: "质控标准建议放宽到RIN>6.5，这样可以保留更多样本", projectId: project1.id, authorId: admin.id },
      { content: "肝脏组织的冷冻切片已经完成5张，质量良好", projectId: project2.id, authorId: admin.id },
      { content: "GEO提交已经完成，登录号为GSE2024001", projectId: project3.id, authorId: user1.id },
    ],
  });

  // Create activity logs
  await prisma.activityLog.createMany({
    data: [
      { type: "PROJECT_CREATED", content: "创建了项目", projectId: project1.id, userId: admin.id },
      { type: "PROJECT_CREATED", content: "创建了项目", projectId: project2.id, userId: user2.id },
      { type: "PROJECT_CREATED", content: "创建了项目", projectId: project3.id, userId: user1.id },
      { type: "PROJECT_CREATED", content: "创建了项目", projectId: project4.id, userId: admin.id },
      { type: "STATUS_CHANGED", content: "项目状态从 NOT_STARTED 变更为 IN_PROGRESS", projectId: project1.id, userId: admin.id, metadata: JSON.stringify({ oldStatus: "NOT_STARTED", newStatus: "IN_PROGRESS" }) },
      { type: "STATUS_CHANGED", content: "项目状态从 IN_PROGRESS 变更为 COMPLETED", projectId: project3.id, userId: user1.id, metadata: JSON.stringify({ oldStatus: "IN_PROGRESS", newStatus: "COMPLETED" }) },
      { type: "STATUS_CHANGED", content: "项目状态从 IN_PROGRESS 变更为 ON_HOLD", projectId: project4.id, userId: admin.id, metadata: JSON.stringify({ oldStatus: "IN_PROGRESS", newStatus: "ON_HOLD" }) },
      { type: "PROGRESS_UPDATED", content: "项目进度更新为 65%", projectId: project1.id, userId: user1.id, metadata: JSON.stringify({ oldProgress: 50, newProgress: 65 }) },
      { type: "COMMENT_ADDED", content: "发表了评论", projectId: project1.id, userId: user1.id },
      { type: "COMMENT_ADDED", content: "发表了评论", projectId: project1.id, userId: admin.id },
      { type: "TICKET_CREATED", content: "创建了工单 \"样本质控未通过\"", projectId: project1.id, userId: admin.id },
      { type: "TICKET_CREATED", content: "创建了工单 \"细胞注释参考库更新\"", projectId: project1.id, userId: user1.id },
    ],
  });

  // Create demo notifications
  await prisma.notification.createMany({
    data: [
      {
        userId: admin.id,
        title: "欢迎使用 SciManage",
        content: "SciManage 是专为单细胞测序与空间转录组科研项目打造的管理平台。",
        type: "SYSTEM",
        read: false,
      },
      {
        userId: admin.id,
        title: "项目进度更新",
        content: "肺癌单细胞测序分析项目进度已更新至 65%。",
        type: "STATUS",
        read: false,
        link: `/projects/${project1.id}`,
      },
      {
        userId: admin.id,
        title: "新工单创建",
        content: "样本质控未通过工单已创建，请尽快处理。",
        type: "TICKET",
        read: true,
        link: `/projects/${project1.id}`,
      },
      {
        userId: user1.id,
        title: "欢迎使用 SciManage",
        content: "SciManage 是专为单细胞测序与空间转录组科研项目打造的管理平台。",
        type: "SYSTEM",
        read: false,
      },
      {
        userId: user1.id,
        title: "项目已完成",
        content: "阿尔茨海默病脑组织scRNA-seq项目已标记为完成。",
        type: "STATUS",
        read: false,
        link: `/projects/${project3.id}`,
      },
      {
        userId: user2.id,
        title: "欢迎使用 SciManage",
        content: "SciManage 是专为单细胞测序与空间转录组科研项目打造的管理平台。",
        type: "SYSTEM",
        read: false,
      },
    ],
  });

  // 本部（系统）代表 + 销售 User —— U4 SYSTEM_FALLBACK 兜底负责人（kind=SYSTEM）。
  // 幂等，密码由内部随机 UUID 生成，无硬编码凭据。
  const hq = await ensureHqRepresentative();
  console.log(`本部系统代表已就绪: representativeId=${hq.representativeId}, ownerUserId=${hq.ownerUserId}`);

  console.log("Seed completed successfully!");
  console.log("Seed accounts (密码由 ADMIN_SEED_PASSWORD / SEED_USER1_PASSWORD / SEED_USER2_PASSWORD 环境变量提供，勿提交仓库):");
  console.log("  admin@example.com / $ADMIN_SEED_PASSWORD");
  console.log("  user1@example.com / $SEED_USER1_PASSWORD");
  console.log("  user2@example.com / $SEED_USER2_PASSWORD");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
