import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadProject, canManageProject } from "@/lib/permissions";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await params;

  const canRead = await canReadProject(projectId, session.user.id, session.user.role);
  if (!canRead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const members = await prisma.projectMember.findMany({
    where: { projectId },
    include: {
      user: {
        select: { id: true, name: true, email: true, avatar: true },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  return NextResponse.json({
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      user: m.user,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await params;

  const canManage = await canManageProject(projectId, session.user.id, session.user.role);
  if (!canManage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { members } = body as {
    members: Array<{ userId: string; role: string }>;
  };

  if (!Array.isArray(members)) {
    return NextResponse.json({ error: "members must be an array" }, { status: 400 });
  }

  // Validate roles
  const VALID_ROLES = new Set(["OWNER", "MEMBER"]);
  for (const m of members) {
    if (!m.userId || !m.role) {
      return NextResponse.json({ error: "每个成员需要 userId 和 role" }, { status: 400 });
    }
    if (!VALID_ROLES.has(m.role)) {
      return NextResponse.json({ error: `无效的成员角色: ${m.role}，仅允许 OWNER 或 MEMBER` }, { status: 400 });
    }
  }

  // Reject duplicate userIds
  const seenUserIds = new Set<string>();
  for (const m of members) {
    if (seenUserIds.has(m.userId)) {
      return NextResponse.json({ error: `重复的用户ID: ${m.userId}` }, { status: 400 });
    }
    seenUserIds.add(m.userId);
  }

  // Must have at least one OWNER
  const ownerCount = members.filter((m) => m.role === "OWNER").length;
  if (ownerCount < 1) {
    return NextResponse.json({ error: "项目至少需要一个负责人" }, { status: 400 });
  }

  // Validate all user IDs exist
  const userIds = [...new Set(members.map((m) => m.userId))];
  const existingUsers = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true },
  });
  if (existingUsers.length !== userIds.length) {
    return NextResponse.json({ error: "包含无效的用户ID" }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
    const previousMembers = await tx.projectMember.findMany({
      where: { projectId },
      select: { userId: true },
    });
    const nextUserIds = new Set(members.map((member) => member.userId));
    const removedUserIds = previousMembers
      .map((member) => member.userId)
      .filter((userId) => !nextUserIds.has(userId));

    // Delete all existing members
    await tx.projectMember.deleteMany({ where: { projectId } });

    // Create new members
    await tx.projectMember.createMany({
      data: members.map((m) => ({
        projectId,
        userId: m.userId,
        role: m.role,
      })),
    });

    if (removedUserIds.length > 0) {
      await tx.agentEntityMemory.updateMany({
        where: {
          userId: { in: removedUserIds },
          entityType: "project",
          entityId: projectId,
        },
        data: { status: "ARCHIVED" },
      });
    }

    // Return the updated member list
    const updatedMembers = await tx.projectMember.findMany({
      where: { projectId },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
      orderBy: { joinedAt: "asc" },
    });
    return updatedMembers;
  });

  await prisma.activityLog.create({
    data: {
      type: "MEMBER_ADDED",
      content: "更新了项目成员",
      projectId,
      userId: session.user.id,
    },
  });

  return NextResponse.json({
    members: result.map((m) => ({
      id: m.id,
      userId: m.userId,
      user: m.user,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
  });
}
