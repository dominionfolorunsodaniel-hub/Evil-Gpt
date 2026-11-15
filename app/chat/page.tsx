
"use client";

import { useState, useRef, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import CustomerNotifications from "@/components/CustomerNotifications";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const welcomeMessage: Message = {
  role: "assistant",
  content: "Evil GPT initialized. What are we working on today?",
};

export default function ChatPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [messages, setMessages] = useState<Message[]>([
    welcomeMessage,
  ]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    let cancelled = false;

    async function loadHistory() {
      try {
        const response = await fetch("/api/chat/history", {
          method: "GET",
          cache: "no-store",
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Unable to load history.");
        }

        if (!cancelled && Array.isArray(data.messages)) {
          setMessages(
            data.messages.length > 0
              ? data.messages
              : [welcomeMessage]
          );
        }
      } catch (error) {
        console.error("Chat history loading error:", error);
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, historyLoading]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();

    const message = input.trim();

    if (!message || loading || historyLoading) return;

    setMessages((previous) => [
      ...previous,
      { role: "user", content: message },
    ]);

    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Request failed.");
      }

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: data.content,
        },
      ]);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Something went wrong.";

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: `Error: ${errorMessage}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading" || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-red-500">
        Initializing Evil Protocols...
      </div>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-red-900 p-4">
        <div>
          <h1 className="text-2xl font-bold tracking-wider text-red-500">
            EVIL GPT
          </h1>
          <p className="text-xs text-gray-500">
            Intelligence without mercy.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-gray-400 sm:block">
            {session.user?.email}
          </span>

          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded border border-red-800 px-3 py-2 text-sm text-red-400 hover:bg-red-950"
          >
            Logout
          </button>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-4">
        <CustomerNotifications />

        <div className="flex-1 space-y-5 pb-6">
          {historyLoading && (
            <div className="text-sm text-red-400 animate-pulse">
              Loading saved conversations...
            </div>
          )}

          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${
                message.role === "user"
                  ? "justify-end"
                  : "justify-start"
              }`}
            >
              <div
                className={`max-w-[90%] whitespace-pre-wrap rounded-lg p-4 ${
                  message.role === "user"
                    ? "border border-red-800 bg-red-950"
                    : "border border-gray-800 bg-gray-900"
                }`}
              >
                <p className="mb-2 text-xs font-bold text-red-400">
                  {message.role === "user" ? "YOU" : "EVIL GPT"}
                </p>

                <p className="text-sm leading-7 text-gray-200">
                  {message.content}
                </p>
              </div>
            </div>
          ))}

          {loading && (
            <div className="text-sm text-red-400 animate-pulse">
              Evil GPT is thinking...
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={sendMessage}
          className="sticky bottom-0 flex gap-2 border-t border-red-900 bg-black py-4"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Evil GPT anything..."
            rows={2}
            disabled={loading || historyLoading}
            className="min-w-0 flex-1 resize-none rounded-lg border border-gray-700 bg-gray-900 p-3 text-white outline-none focus:border-red-500"
          />

          <button
            type="submit"
            disabled={loading || historyLoading || !input.trim()}
            className="rounded-lg bg-red-600 px-5 font-bold text-white hover:bg-red-700 disabled:opacity-40"
          >
            SEND
          </button>
        </form>
      </section>
    </main>
  );
}
