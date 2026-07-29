import { prisma } from "./prisma";
import { getMagicLinkUrl } from "./app-url";

export const REPRESENTATIVE_MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;

function generateToken() {
  return crypto.randomUUID() + crypto.randomUUID();
}

function tokenSuffix(token: string): string {
  return token.slice(-6);
}

/**
 * Unified helper: reuse unexpired token, or generate a new one.
 * Uses a single atomic SQL UPDATE (CASE expression) so the decision
 * and the write happen in one statement — no read-then-write race.
 * Returns the magicLink and whether this was a reuse or new issue.
 */
export async function issueOrReuseRepresentativeMagicLink(
  repId: string,
  redirect?: string,
): Promise<{ magicLink: string; action: "reuse" | "issue" }> {
  const now = new Date();
  const nowISO = now.toISOString();
  const newToken = generateToken();
  const newExpiry = new Date(now.getTime() + REPRESENTATIVE_MAGIC_LINK_TTL_MS);
  const newExpiryISO = newExpiry.toISOString();

  // Single atomic statement with RETURNING: the persisted token comes
  // directly out of the write, so there is no readback race window.
  const rows = await prisma.$queryRawUnsafe<Array<{ token: string | null }>>(
    `UPDATE Representative
       SET token = CASE
             WHEN token IS NULL OR tokenExpiresAt IS NULL OR tokenExpiresAt <= ?
             THEN ?
             ELSE token
           END,
           tokenExpiresAt = CASE
             WHEN token IS NULL OR tokenExpiresAt IS NULL OR tokenExpiresAt <= ?
             THEN ?
             ELSE tokenExpiresAt
           END
     WHERE id = ? AND archived = 0
     RETURNING token`,
    nowISO, newToken, nowISO, newExpiryISO, repId,
  );

  // Read back email separately (non-critical for the race, just for logging)
  const rep = await prisma.representative.findUnique({
    where: { id: repId },
    select: { email: true, archived: true },
  });

  if (!rep) throw new Error("Representative not found");
  if (rep.archived) throw new Error("Representative is archived");

  const finalToken = rows[0]?.token ?? newToken;
  const isReuse = finalToken !== newToken;

  console.log(`[MAGIC_LINK] action=${isReuse ? "reuse" : "issue"} rep=${rep.email} suffix=${tokenSuffix(finalToken)} result=ok`);
  return { magicLink: getMagicLinkUrl(finalToken, redirect), action: isReuse ? "reuse" : "issue" };
}

export async function generateRepresentativeLoginLink(
  email: string,
  redirect?: string,
): Promise<{ magicLink: string | null; isRepresentative: boolean }> {
  const rep = await prisma.representative.findUnique({
    where: { email },
  });

  if (!rep) {
    return { magicLink: null, isRepresentative: false };
  }

  const { magicLink } = await issueOrReuseRepresentativeMagicLink(rep.id, redirect);
  return { magicLink, isRepresentative: true };
}

export async function notifyRepresentativeById(
  repId: string,
  repEmail: string,
  redirect: string,
  notifications: Array<{ subject: string; text: string; html: string }>,
): Promise<{ ok: boolean }> {
  const rep = await prisma.representative.findUnique({
    where: { id: repId, archived: false },
  });
  if (!rep) return { ok: false };

  const { magicLink } = await issueOrReuseRepresentativeMagicLink(rep.id, redirect);

  import("./mail").then(({ sendMail }) => {
    for (const n of notifications) {
      sendMail({
        to: repEmail,
        subject: n.subject,
        text: n.text,
        html: appendLoginLinkToEmail(n.html, magicLink),
      }).catch((err) => {
        console.error("[MAGIC_LINK] SMTP notification failed for", repEmail, err);
      });
    }
  }).catch(() => {});

  return { ok: true };
}

export async function notifyRepresentative(
  repEmail: string,
  redirect: string,
  notifications: Array<{ subject: string; text: string; html: string }>,
): Promise<{ ok: boolean }> {
  const rep = await prisma.representative.findUnique({
    where: { email: repEmail },
  });

  if (!rep || rep.archived) {
    return { ok: false };
  }

  const { magicLink } = await issueOrReuseRepresentativeMagicLink(rep.id, redirect);

  // Fire-and-forget — token is already saved, delivery failure is non-fatal
  import("./mail").then(({ sendMail }) => {
    for (const n of notifications) {
      sendMail({
        to: rep.email,
        subject: n.subject,
        text: n.text,
        html: appendLoginLinkToEmail(n.html, magicLink),
      }).catch((err) => {
        console.error("[MAGIC_LINK] SMTP notification failed for", rep.email, err);
      });
    }
  }).catch(() => {});

  return { ok: true };
}

export function appendLoginLinkToEmail(
  html: string,
  magicLink: string | null,
): string {
  if (!magicLink) return html;

  const loginSection = `
<div style="margin-top: 24px; padding: 16px; background: #f0f9ff; border-radius: 8px; border: 1px solid #bae6fd;">
  <p style="margin: 0 0 8px 0; font-size: 14px; color: #0369a1;">👋 代表快捷登录</p>
  <p style="margin: 0 0 12px 0; font-size: 13px; color: #334155;">作为项目代表，您可以点击下方按钮直接登录查看，无需输入密码：</p>
  <a href="${magicLink}" style="display: inline-block; background: #0284c7; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">一键登录查看</a>
  <p style="margin: 8px 0 0 0; font-size: 11px; color: #64748b;">链接有效期 24 小时</p>
</div>`;

  if (html.includes("</div>")) {
    const lastDiv = html.lastIndexOf("</div>");
    return html.slice(0, lastDiv) + loginSection + html.slice(lastDiv);
  }
  return html + loginSection;
}
