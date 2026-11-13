"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Dashboard() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const checkAuth = () => {
      const adminStatus = localStorage.getItem("isAdmin");
      if (adminStatus !== "true") {
        router.push("/login");
      } else {
        setIsAdmin(true);
        setLoading(false);
      }
    };
    checkAuth();
  }, [router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-red-500">
        <p className="animate-pulse">Initializing Evil Protocols...</p>
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8 border-b border-red-900 pb-4">
          <h1 className="text-4xl font-bold text-red-600 tracking-wider">
            EVIL GPT <span className="text-sm text-gray-500">v1.0 // ADMIN MODE</span>
          </h1>
          <p className="text-gray-400 mt-2">System Status: <span className="text-green-500">ONLINE</span></p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: Broadcast Control */}
          <div className="p-6 border border-gray-800 bg-gray-900 rounded-lg hover:border-red-500 transition-colors">
            <h2 className="text-xl font-bold text-red-400 mb-4">📡 Broadcast System</h2>
            <p className="text-sm text-gray-400 mb-4">Send updates to all connected nodes.</p>
            <button className="w-full py-2 bg-red-900 hover:bg-red-700 text-white rounded transition">
              Send Broadcast
            </button>
          </div>

          {/* Card 2: User Management */}
          <div className="p-6 border border-gray-800 bg-gray-900 rounded-lg hover:border-red-500 transition-colors">
            <h2 className="text-xl font-bold text-red-400 mb-4">👥 User Management</h2>
            <p className="text-sm text-gray-400 mb-4">View and ban users.</p>
            <button className="w-full py-2 bg-gray-800 hover:bg-gray-700 text-white rounded transition">
              Manage Users
            </button>
          </div>
        </div>

        <div className="mt-8 p-4 border border-red-900 bg-black">
          <h3 className="text-lg font-bold text-red-500 mb-2">📜 Activity Log</h3>
          <div className="h-32 overflow-y-auto text-sm text-gray-500 font-mono">
            <p>[20:00:01] System initialized.</p>
            <p>[20:00:02] Admin session started.</p>
            <p>[20:00:05] Waiting for commands...</p>
          </div>
        </div>

        <button 
          onClick={() => {
            localStorage.removeItem("isAdmin");
            router.push("/login");
          }}
          className="mt-8 text-sm text-gray-500 hover:text-red-500"
        >
          Logout
        </button>
      </div>
    </div>
  );
}
