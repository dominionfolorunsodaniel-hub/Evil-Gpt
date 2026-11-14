
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Registration failed.");
        return;
      }

      router.push("/login?registered=true");
    } catch (err) {
      console.error("Registration error:", err);
      setError("Unable to connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#070707] text-white flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="text-3xl font-black tracking-widest text-red-600">
            EVIL<span className="text-white">GPT</span>
          </Link>

          <p className="mt-3 text-xs tracking-[0.3em] text-red-500">
            INITIALIZE YOUR ACCESS
          </p>

          <h1 className="mt-5 text-3xl font-bold">
            Create Your Account
          </h1>

          <p className="mt-2 text-sm text-gray-500">
            Enter your details to enter the system.
          </p>
        </div>

        <form
          onSubmit={handleRegister}
          className="border border-red-900/50 bg-[#101010] rounded-xl p-7 shadow-[0_0_35px_rgba(180,0,0,0.12)] space-y-5"
        >
          <div>
            <label className="block text-sm text-gray-300 mb-2">
              Full Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
              maxLength={80}
              autoComplete="name"
              className="w-full bg-black border border-gray-800 rounded-lg px-4 py-3 text-white outline-none focus:border-red-600"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-2">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              className="w-full bg-black border border-gray-800 rounded-lg px-4 py-3 text-white outline-none focus:border-red-600"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-2">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              className="w-full bg-black border border-gray-800 rounded-lg px-4 py-3 text-white outline-none focus:border-red-600"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-2">
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Enter password again"
              required
              autoComplete="new-password"
              className="w-full bg-black border border-gray-800 rounded-lg px-4 py-3 text-white outline-none focus:border-red-600"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded-lg p-3">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg py-3 font-bold tracking-wider transition"
          >
            {loading ? "CREATING ACCOUNT..." : "CREATE ACCOUNT"}
          </button>

          <p className="text-center text-sm text-gray-500">
            Already have an account?{" "}
            <Link href="/login" className="text-red-500 hover:text-red-400">
              Sign in
            </Link>
          </p>
        </form>

        <p className="text-center text-xs text-gray-700 mt-6">
          EVIL GPT — INTELLIGENCE WITHOUT MERCY.
        </p>
      </div>
    </main>
  );
}

