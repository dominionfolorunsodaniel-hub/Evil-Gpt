
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { neon } from '@neondatabase/serverless';
import { authOptions } from '@/lib/auth';
import { MemoryManager } from '@/lib/ai/memory';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401 }
      );
    }

    const user = session.user as { id?: string };

    if (!user.id) {
      return NextResponse.json(
        { error: 'Invalid user session.' },
        { status: 401 }
      );
    }

    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      return NextResponse.json(
        { error: 'Database is not configured.' },
        { status: 503 }
      );
    }

    const db = neon(databaseUrl);
    const memory = new MemoryManager(db, user.id);

    const history = await memory.getRecentHistory(100);

    const messages = history
      .filter(
        (message) =>
          message.role === 'user' ||
          message.role === 'assistant'
      )
      .map((message) => ({
        role: message.role,
        content: message.content ?? '',
      }));

    return NextResponse.json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error('[Chat History API Error]:', error);

    return NextResponse.json(
      { error: 'Unable to retrieve chat history.' },
      { status: 500 }
    );
  }
}

