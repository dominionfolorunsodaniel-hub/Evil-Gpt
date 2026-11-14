
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Engine } from '@/lib/ai/engine';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    // Verify the logged-in user.
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401 }
      );
    }

    const user = session.user as {
      id?: string;
      email?: string;
    };

    if (!user.id) {
      return NextResponse.json(
        { error: 'Invalid user session.' },
        { status: 401 }
      );
    }

    // Validate the incoming message.
    const body = await request.json();
    const message = body?.message;

    if (
      typeof message !== 'string' ||
      !message.trim() ||
      message.length > 20000
    ) {
      return NextResponse.json(
        { error: 'Please provide a valid message.' },
        { status: 400 }
      );
    }

    if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'AI service configuration is incomplete.' },
        { status: 503 }
      );
    }

    // Initialize the existing AI engine for this user.
    const engine = new Engine({
      modelType: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      dbUrl: process.env.DATABASE_URL,
      userId: user.id,
    });

    const response = await engine.process(message);

    return NextResponse.json({
      success: true,
      response,
    });
  } catch (error) {
    console.error('[Chat API Error]:', error);

    return NextResponse.json(
      { error: 'Unable to process your message. Please try again.' },
      { status: 500 }
    );
  }
}

