
"use client";

import { useCallback, useEffect, useState } from "react";

interface CustomerNotification {
  id: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsResponse {
  success: boolean;
  notifications?: CustomerNotification[];
  unreadCount?: number;
  error?: string;
}

export default function CustomerNotifications() {
  const [notifications, setNotifications] = useState<
    CustomerNotification[]
  >([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/notifications", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });

      const data: NotificationsResponse = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Unable to load notifications."
        );
      }

      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  const markAsRead = async (notificationId: string) => {
    setUpdatingId(notificationId);
    setError("");

    try {
      const response = await fetch("/api/notifications", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ notificationId }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Unable to update notification."
        );
      }

      if (data.updated) {
        setNotifications((current) =>
          current.map((notification) =>
            notification.id === notificationId
              ? {
                  ...notification,
                  readAt: new Date().toISOString(),
                }
              : notification
          )
        );

        setUnreadCount((current) => Math.max(0, current - 1));
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update notification."
      );
    } finally {
      setUpdatingId(null);
    }
  };

  const formatDate = (date: string) => {
    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      return "Date unavailable";
    }

    return parsedDate.toLocaleString();
  };

  return (
    <section className="w-full space-y-5 rounded-xl border border-red-900/50 bg-black p-5 text-white shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-red-500">
            NOTIFICATIONS
          </h2>

          <p className="mt-1 text-sm text-gray-400">
            Announcements and updates from Evil GPT.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="rounded-full border border-red-700 bg-red-950 px-3 py-1 text-sm font-semibold text-red-400">
            {unreadCount} unread
          </span>

          <button
            type="button"
            onClick={() => void fetchNotifications()}
            disabled={loading}
            className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 transition hover:border-red-600 hover:text-white disabled:opacity-50"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-700 bg-red-950/40 p-3 text-sm text-red-400"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-gray-400">
          Loading notifications...
        </div>
      ) : notifications.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-950 p-8 text-center">
          <p className="text-lg font-semibold text-gray-300">
            No notifications yet
          </p>

          <p className="mt-2 text-sm text-gray-500">
            Administrator announcements and updates will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => (
            <article
              key={notification.id}
              className={`rounded-lg border p-4 transition ${
                notification.readAt
                  ? "border-gray-800 bg-gray-950"
                  : "border-red-800 bg-red-950/20"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-white">
                    {notification.title}
                  </h3>

                  {!notification.readAt && (
                    <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                      NEW
                    </span>
                  )}
                </div>

                <span className="text-xs text-gray-500">
                  {formatDate(notification.createdAt)}
                </span>
              </div>

              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-gray-300">
                {notification.message}
              </p>

              {!notification.readAt && (
                <button
                  type="button"
                  onClick={() => void markAsRead(notification.id)}
                  disabled={updatingId === notification.id}
                  className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {updatingId === notification.id
                    ? "Updating..."
                    : "Mark as read"}
                </button>
              )}

              {notification.readAt && (
                <p className="mt-3 text-xs text-gray-500">
                  Read
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
  }
        
