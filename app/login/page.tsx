
"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn, getSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (!result || result.error) {
        setError("Access Denied. Check your email and password.");
        return;
      }

      const session = await getSession();
      const role = (session?.user as { role?: string } | undefined)?.role;

      router.push(role === "ADMIN" ? "/dashboard" : "/chat");
      router.refresh();
    } catch (err) {
      console.error("Login error:", err);
      setError("Unable to sign in. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-white">
      <div className="w-full max-w-md rounded-lg border border-red-600 p-8 shadow-lg">
        <h2 className="mb-4 text-2xl font-bold text-red-500">
          EVIL GPT LOGIN
        </h2>

        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="email"
            placeholder="Email"
            autoComplete="email"
            required
            className="w-full border border-gray-700 bg-gray-900 p-2 text-white"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            required
            className="w-full border border-gray-700 bg-gray-900 p-2 text-white"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 p-2 font-bold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "AUTHENTICATING..." : "ENTER"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-400">
          Don't have an account?{" "}
          <Link
            href="/register"
            className="font-bold text-red-500 hover:text-red-400"
          >
            Create Account
          </Link>
        </p>
      </div>
    </div>
  );
}
