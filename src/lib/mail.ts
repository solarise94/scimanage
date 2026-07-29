import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;
let etherealAccount: nodemailer.TestAccount | null = null;
let isRealSMTP = false;

function getSMTPConfigStatus() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const missing = [
    !host ? "SMTP_HOST" : null,
    !port ? "SMTP_PORT" : null,
    !user ? "SMTP_USER" : null,
    !pass ? "SMTP_PASS" : null,
  ].filter((key): key is string => Boolean(key));

  return {
    host,
    port,
    user,
    pass,
    missing,
    configured: missing.length === 0,
    partial: missing.length > 0 && missing.length < 4,
  };
}

function getSMTPConfig() {
  const status = getSMTPConfigStatus();
  if (status.configured) {
    return {
      host: status.host!,
      port: Number(status.port),
      secure: Number(status.port) === 465,
      auth: { user: status.user!, pass: status.pass! },
    };
  }
  return null;
}

async function createEtherealTransporter(): Promise<nodemailer.Transporter> {
  if (!etherealAccount) {
    etherealAccount = await nodemailer.createTestAccount();
    console.log("[SMTP] Using Ethereal test account (no real SMTP configured)");
    console.log("  Preview URL base: https://ethereal.email");
    console.log("  User:", etherealAccount.user);
  }
  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: etherealAccount.user,
      pass: etherealAccount.pass,
    },
  });
}

export async function getTransporter(): Promise<nodemailer.Transporter> {
  if (transporter) return transporter;

  const realConfig = getSMTPConfig();
  if (realConfig) {
    transporter = nodemailer.createTransport(realConfig);
    isRealSMTP = true;
    console.log("[SMTP] Real SMTP configured:", realConfig.host);
  } else {
    const status = getSMTPConfigStatus();
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `[SMTP] SMTP not fully configured in production (missing: ${status.missing.join(", ") || "all"}). ` +
        `Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.`,
      );
    }
    if (status.partial) {
      console.warn(
        `[SMTP] Incomplete SMTP config, missing ${status.missing.join(", ")}; falling back to Ethereal (dev only)`,
      );
    }
    transporter = await createEtherealTransporter();
    isRealSMTP = false;
  }

  return transporter;
}

export function smtpEnabled(): boolean {
  return getSMTPConfigStatus().configured;
}

export interface SendMailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
}

export type MailTransportKind = "real" | "test";

export async function sendMail(options: SendMailOptions) {
  const transport = await getTransporter();
  const fromAddr = process.env.SMTP_FROM || '"SciManage" <reminder@scimanage.com>';
  const info = await transport.sendMail({
    from: fromAddr,
    to: options.to,
    cc: options.cc,
    subject: options.subject,
    text: options.text,
    html: options.html,
  });
  const transportKind: MailTransportKind = isRealSMTP ? "real" : "test";
  console.log(
    `[SMTP] Email sent (${transportKind}):`,
    info.messageId,
  );
  return { messageId: info.messageId, transport: transportKind };
}

/**
 * Send email in the background, updating the Notification record with the result.
 * Fire-and-forget — does not block the caller. Errors are logged and recorded.
 */
export function sendMailInBackground(
  options: SendMailOptions,
  notificationId: string,
): void {
  // Dynamic import to avoid circular dependency with prisma
  const run = async () => {
    const { prisma } = await import("@/lib/prisma");
    try {
      await sendMail(options);
      await prisma.notification.update({
        where: { id: notificationId },
        data: { emailStatus: "sent" },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "未知错误";
      console.error(`[SMTP] Background email failed for notification ${notificationId}:`, msg);
      await prisma.notification.update({
        where: { id: notificationId },
        data: { emailStatus: "failed", emailError: msg.slice(0, 500) },
      }).catch(() => {});
    }
  };
  run().catch(() => {});
}
