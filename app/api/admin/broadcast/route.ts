
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { sendBroadcast } from '@/lib/notifications';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    // Only administrators can send broadcasts.
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required.' },
        { status: 401 }
      );
    }

    const user = session.user as { role?: string };

    if (user.role !== 'ADMIN') {
      return NextResponse.json(
        { success: false, error: 'Administrator access required.' },
        { status: 403 }
      );
    }

    const body = await request.json();

    const title =
      typeof body.title === 'string' ? body.title.trim() : '';

    const message =
      typeof body.message === 'string' ? body.message.trim() : '';

    if (!title || !message) {
      return NextResponse.json(
        { success: false, error: 'Title and message are required.' },
        { status: 400 }
      );
    }

    if (title.length > 120 || message.length > 5000) {
      return NextResponse.json(
        {
          success: false,
          error: 'Title must be at most 120 characters and message at most 5000 characters.',
        },
        { status: 400 }
      );
    }

    const sentCount = await sendBroadcast(title, message);

    return NextResponse.json({
      success: true,
      message: 'Broadcast created successfully.',
      sentCount,
    });
  } catch (error) {
    console.error('Broadcast API error:', error);

    return NextResponse.json(
      { success: false, error: 'Unable to send broadcast.' },
      { status: 500 }
    );
  }
}

