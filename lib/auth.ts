
import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@next-auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import prisma from './prisma';

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),

  session: {
    strategy: 'jwt',
  },

  pages: {
    signIn: '/login',
  },

  providers: [
    CredentialsProvider({
      name: 'Evil GPT',
      credentials: {
        email: {
          label: 'Username or Email',
          type: 'text',
        },
        password: {
          label: 'Password',
          type: 'password',
        },
      },

      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const identifier = credentials.email.trim();
        const password = credentials.password;

        // Check the admin credentials configured in Render.
        const adminUsername = process.env.ADMIN_USERNAME?.trim();
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (
          adminUsername &&
          adminPassword &&
          identifier.toLowerCase() === adminUsername.toLowerCase() &&
          password === adminPassword
        ) {
          return {
            id: 'render-admin',
            name: adminUsername,
            email: `${adminUsername}@admin.local`,
            role: 'ADMIN',
          } as any;
        }

        // Otherwise, authenticate a registered customer.
        const email = identifier.toLowerCase();

        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user?.password) {
          return null;
        }

        const passwordValid = await bcrypt.compare(
          password,
          user.password
        );

        if (!passwordValid) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        } as any;
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const authenticatedUser = user as typeof user & {
          role?: 'USER' | 'ADMIN';
        };

        token.role = authenticatedUser.role ?? 'USER';
      }

      return token;
    },

    async session({ session, token }) {
      if (session.user && token.sub) {
        const sessionUser = session.user as typeof session.user & {
          id: string;
          role: 'USER' | 'ADMIN';
        };

        sessionUser.id = token.sub;
        sessionUser.role =
          (token.role as 'USER' | 'ADMIN') ?? 'USER';
      }

      return session;
    },
  },

  secret: process.env.NEXTAUTH_SECRET,
};

