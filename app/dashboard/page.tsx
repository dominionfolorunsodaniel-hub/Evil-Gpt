import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";

export default async function Dashboard() {
const session = await getServerSession(authOptions);

if (!session?.user) {
redirect("/login");
}

const role = (session.user as { role?: string }).role;

if (role !== "ADMIN") {
redirect("/chat");
}

return (
<div className="min-h-screen bg-black p-8 text-white">
<div className="mx-auto max-w-4xl">
<header className="mb-8 border-b border-red-900 pb-4">
<h1 className="text-4xl font-bold tracking-wider text-red-600">
EVIL GPT{" "}
<span className="text-sm text-gray-500">
v1.0 // ADMIN MODE
</span>
</h1>

      <p className="mt-2 text-gray-400">
        System Status:{" "}
        <span className="text-green-500">ONLINE</span>
      </p>

      <p className="mt-2 text-sm text-gray-400">
        Administrator: {session.user.email}
      </p>
    </header>

    {/* AI Chat Access */}
    <div className="mb-6">
      <a
        href="/chat"
        className="block w-full rounded-lg border border-red-700 bg-red-950 p-4 text-center font-bold tracking-wider text-red-400 transition-colors hover:bg-red-900 hover:text-white"
      >
        OPEN EVIL GPT CHAT →
      </a>
      <p className="mt-2 text-center text-xs text-gray-500">
        Access your AI assistant directly from the admin dashboard.
      </p>
    </div>

    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 transition-colors hover:border-red-500">
        <h2 className="mb-4 text-xl font-bold text-red-400">
          📡 Broadcast System
        </h2>
        <p className="mb-4 text-sm text-gray-400">
          Send updates to all connected nodes.
        </p>
        <button
          disabled
          className="w-full rounded bg-red-900 py-2 text-white opacity-60"
        >
          Send Broadcast
        </button>
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 transition-colors hover:border-red-500">
        <h2 className="mb-4 text-xl font-bold text-red-400">
          👥 User Management
        </h2>
        <p className="mb-4 text-sm text-gray-400">
          View and manage users.
        </p>
        <button
          disabled
          className="w-full rounded bg-gray-800 py-2 text-white opacity-60"
        >
          Manage Users
        </button>
      </div>
    </div>

    <div className="mt-8 border border-red-900 bg-black p-4">
      <h3 className="mb-2 text-lg font-bold text-red-500">
        📜 Activity Log
      </h3>
      <div className="h-32 overflow-y-auto font-mono text-sm text-gray-500">
        <p>System initialized.</p>
        <p>Administrator session verified.</p>
        <p>Waiting for commands...</p>
      </div>
    </div>

    <a
      href="/api/auth/signout"
      className="mt-8 inline-block text-sm text-gray-500 hover:text-red-500"
    >
      Logout
    </a>
  </div>
</div>

);
}
