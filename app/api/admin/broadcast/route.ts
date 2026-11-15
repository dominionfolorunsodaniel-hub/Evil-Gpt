
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import {
  ensureNotificationTable,
  getUserNotifications,
} from '@/lib/notifications';

export const runtime = 'nodejs';

async function getAuthenticatedUser() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return null;
  }

  const user = session.user as {
    id?: string;
    role?: string;
  };

  if (!user.id || user.role !== 'USER') {
    return null;
  }

  return user;
}

// GET customer's notifications
export async function GET() {
  try {
    const user = await getAuthenticatedUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Customer authentication required.' },
        { status: 401 }
      );
    }

    const notifications = await getUserNotifications(user.id!);

    return NextResponse.json({
      success: true,
      notifications,
      unreadCount: notifications.filter(
        (notification) => !notification.readAt
      ).length,
    });
  } catch (error) {
    console.error('Notifications GET error:', error);

    return NextResponse.json(
      { success: false, error: 'Unable to retrieve notifications.' },
      { status: 500 }
    );
  }
}

// PATCH marks a customer's notification as read
export async function PATCH(request: Request) {
  try {
    const user = await getAuthenticatedUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Customer authentication required.' },
        { status: 401 }
      );
    }

    const body = await request.json();

    const notificationId =
      typeof body.notificationId === 'string'
        ? body.notificationId.trim()
        : '';

    if (!notificationId) {
      return NextResponse.json(
        { success: false, error: 'Notification ID is required.' },
        { status: 400 }
      );
    }

    await ensureNotificationTable();

    const updated = await prisma.$executeRaw`
      UPDATE "Notification"
      SET "readAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${notificationId}
        AND "userId" = ${user.id!}
        AND "readAt" IS NULL
    `;

    return NextResponse.json({
      success: true,
      updated: updated > 0,
      message: updated > 0
        ? 'Notification marked as read.'
        : 'Notification was already read or was not found.',
    });
  } catch (error) {
    console.error('Notifications PATCH error:', error);

    return NextResponse.json(
      { success: false, error: 'Unable to update notification.' },
      { status: 500 }
    );
  }
}
