"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    // Simple hardcoded check for now (replace with DB later)
    if (username === "admin" && password === "evil123") {
      localStorage.setItem("isAdmin", "true");
      router.push("/dashboard");
    } else {
      setError("Access Denied. Try again.");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-white">
      <div className="w-full max-w-md p-8 border border-red-600 rounded-lg shadow-lg">
        <h2 className="text-2xl font-bold text-red-500 mb-4">EVIL GPT LOGIN</h2>
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="text"
            placeholder="Username"
            className="w-full p-2 bg-gray-900 border border-gray-700 text-white"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            type="password"
            placeholder="Password"
            className="w-full p-2 bg-gray-900 border border-gray-700 text-white"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            type="submit"
            className="w-full p-2 bg-red-600 hover:bg-red-700 text-white font-bold"
          >
            ENTER
          </button>
        </form>
      </div>
    </div>
  );
        }
