
import prisma from '@/lib/prisma';
import { randomUUID } from 'crypto';

export interface CustomerNotification {
  id: string;
  title: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
}

export async function ensureNotificationTable() {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "Notification" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "title" VARCHAR(120) NOT NULL,
      "message" TEXT NOT NULL,
      "readAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx"
    ON "Notification" ("userId", "createdAt" DESC)
  `;
}

export async function sendBroadcast(
  title: string,
  message: string
): Promise<number> {
  await ensureNotificationTable();

  const notificationId = randomUUID();

  return prisma.$executeRaw`
    INSERT INTO "Notification" (
      "id",
      "userId",
      "title",
      "message"
    )
    SELECT
      ${notificationId} || '-' || "id",
      "id",
      ${title},
      ${message}
    FROM "User"
    WHERE
      "role" = 'USER'::"Role"
      AND "accountStatus" = 'APPROVED'::"AccountStatus"
  `;
}

export async function getUserNotifications(
  userId: string
): Promise<CustomerNotification[]> {
  await ensureNotificationTable();

  return prisma.$queryRaw<CustomerNotification[]>`
    SELECT
      "id",
      "title",
      "message",
      "readAt",
      "createdAt"
    FROM "Notification"
    WHERE "userId" = ${userId}
    ORDER BY "createdAt" DESC
    LIMIT 100
  `;
}

