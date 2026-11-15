
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required.' },
        { status: 401 }
      );
    }

    const sessionUser = session.user as {
      id?: string;
      role?: string;
    };

    if (!sessionUser.id || sessionUser.role !== 'USER') {
      return NextResponse.json(
        { success: false, error: 'Customer access required.' },
        { status: 403 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        accountStatus: true,
        createdAt: true,
        subscription: {
          select: {
            plan: true,
            status: true,
            startsAt: true,
            expiresAt: true,
          },
        },
        payments: {
          select: {
            id: true,
            reference: true,
            amount: true,
            currency: true,
            status: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 50,
        },
      },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Customer account not found.' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      account: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus,
        createdAt: user.createdAt,
        subscription: user.subscription,
        payments: user.payments.map((payment) => ({
          ...payment,
          amount: payment.amount.toString(),
        })),
      },
    });
  } catch (error) {
    console.error('Customer account API error:', error);

    return NextResponse.json(
      { success: false, error: 'Unable to retrieve customer account.' },
      { status: 500 }
    );
  }
  }
        
