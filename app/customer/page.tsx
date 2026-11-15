
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Payment {
  id: string;
  reference: string;
  amount: string;
  currency: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
}

interface Subscription {
  plan: string;
  status: "ACTIVE" | "EXPIRED" | "CANCELLED";
  startsAt: string;
  expiresAt: string;
}

interface CustomerAccount {
  id: string;
  name: string | null;
  email: string;
  role: string;
  accountStatus: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  subscription: Subscription | null;
  payments: Payment[];
}

interface AccountResponse {
  success: boolean;
  account?: CustomerAccount;
  error?: string;
}

const navigation = [
  { label: "Dashboard", href: "#overview" },
  { label: "My Account", href: "#account" },
  { label: "My Subscription", href: "#subscription" },
  { label: "Usage Statistics", href: "#usage" },
  { label: "Billing History", href: "#billing" },
  { label: "Notifications", href: "/chat" },
  { label: "Upgrade Plan", href: "#upgrade" },
  { label: "Help & Support", href: "#support" },
  { label: "Personalization", href: "#personalization" },
];

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    APPROVED: "border-green-800 bg-green-950 text-green-400",
    ACTIVE: "border-green-800 bg-green-950 text-green-400",
    PENDING: "border-yellow-800 bg-yellow-950 text-yellow-400",
    REJECTED: "border-red-800 bg-red-950 text-red-400",
    EXPIRED: "border-gray-700 bg-gray-900 text-gray-400",
    CANCELLED: "border-gray-700 bg-gray-900 text-gray-400",
  };

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${
        styles[status] || "border-gray-700 bg-gray-900 text-gray-400"
      }`}
    >
      {status}
    </span>
  );
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unavailable";
  }

  return date.toLocaleDateString();
}

function formatAmount(amount: string, currency: string) {
  const value = Number(amount);

  if (!Number.isFinite(value)) {
    return `${amount} ${currency}`;
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(value);
}

export default function CustomerPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [account, setAccount] = useState<CustomerAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/customer/account", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });

      const data: AccountResponse = await response.json();

      if (!response.ok || !data.success || !data.account) {
        throw new Error(data.error || "Unable to load your account.");
      }

      setAccount(data.account);
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
    if (status === "unauthenticated") {
      router.replace("/login");
    }

    if (status === "authenticated") {
      void loadAccount();
    }
  }, [status, router, loadAccount]);

  if (status === "loading" || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black text-red-500">
        Loading customer dashboard...
      </main>
    );
  }

  if (!session) {
    return null;
  }

  if (error || !account) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black p-5 text-white">
        <div className="w-full max-w-md rounded-xl border border-red-900 bg-gray-950 p-6 text-center">
          <h1 className="text-xl font-bold text-red-500">
            ACCOUNT UNAVAILABLE
          </h1>

          <p className="mt-3 text-sm text-gray-400">
            {error || "Your account information could not be loaded."}
          </p>

          <button
            onClick={() => void loadAccount()}
            className="mt-5 rounded-lg bg-red-600 px-5 py-2 font-semibold hover:bg-red-700"
          >
            Try Again
          </button>
        </div>
      </main>
    );
  }

  const activeSubscription =
    account.subscription?.status === "ACTIVE" &&
    new Date(account.subscription.expiresAt).getTime() > Date.now();

  return (
    <main className="min-h-screen bg-black text-white">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-red-900 px-5 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-wider text-red-500">
            EVIL GPT
          </h1>
          <p className="text-xs text-gray-500">
            CUSTOMER DASHBOARD
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => router.push("/chat")}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-red-600 hover:text-white"
          >
            Open Chat
          </button>

          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded-lg border border-red-800 px-4 py-2 text-sm text-red-400 hover:bg-red-950"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">

        {/* Mobile Navigation */}
        <nav className="mb-6 overflow-x-auto rounded-xl border border-gray-800 bg-gray-950 p-2 lg:hidden">
          <div className="flex min-w-max gap-2">
            {navigation.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="rounded-lg border border-gray-800 px-3 py-2 text-xs text-gray-300 transition hover:border-red-600 hover:bg-red-950 hover:text-white"
              >
                {item.label}
              </a>
            ))}
          </div>
        </nav>

        <div className="flex flex-col gap-6 lg:flex-row">

          {/* Desktop Sidebar */}
          <aside className="hidden w-64 shrink-0 lg:block">
            <nav className="sticky top-6 rounded-xl border border-gray-800 bg-gray-950 p-4">
              <h2 className="mb-4 px-3 text-xs font-bold tracking-widest text-red-500">
                CUSTOMER MENU
              </h2>

              <div className="space-y-1">
                {navigation.map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    className="block rounded-lg px-3 py-3 text-sm text-gray-400 transition hover:bg-red-950 hover:text-white"
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </nav>
          </aside>

          {/* Main Dashboard */}
          <div className="min-w-0 flex-1 space-y-7">

            <section id="overview" className="scroll-mt-6">
              <h2 className="text-2xl font-bold">
                Welcome, {account.name || "Customer"}
              </h2>

              <p className="mt-2 text-sm text-gray-400">
                Manage your account, subscription and payments.
              </p>
            </section>

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-xl border border-red-900/60 bg-gray-950 p-5">
                <p className="text-sm text-gray-400">Account Status</p>
                <div className="mt-3">
                  <StatusBadge status={account.accountStatus} />
                </div>
              </div>

              <div className="rounded-xl border border-red-900/60 bg-gray-950 p-5">
                <p className="text-sm text-gray-400">Subscription</p>
                <p className="mt-3 text-xl font-bold text-red-400">
                  {account.subscription?.plan || "No subscription"}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {account.subscription?.status || "Not subscribed"}
                </p>
              </div>

              <div className="rounded-xl border border-red-900/60 bg-gray-950 p-5">
                <p className="text-sm text-gray-400">Payment Records</p>
                <p className="mt-3 text-2xl font-bold">
                  {account.payments.length}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Latest 50 records
                </p>
              </div>
            </section>

            <section
              id="account"
              className="scroll-mt-6 rounded-xl border border-gray-800 bg-gray-950 p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-bold text-red-400">
                  MY ACCOUNT
                </h3>

                <button
                  onClick={() => void loadAccount()}
                  className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:border-red-600"
                >
                  Refresh Account
                </button>
              </div>

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-gray-500">Full Name</p>
                  <p className="mt-1 break-words">
                    {account.name || "Not provided"}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-gray-500">Email Address</p>
                  <p className="mt-1 break-words">{account.email}</p>
                </div>

                <div>
                  <p className="text-xs text-gray-500">Customer ID</p>
                  <p className="mt-1 break-all text-sm">{account.id}</p>
                </div>

                <div>
                  <p className="text-xs text-gray-500">Registration Date</p>
                  <p className="mt-1">{formatDate(account.createdAt)}</p>
                </div>
              </div>
            </section>

            <section
              id="subscription"
              className="scroll-mt-6 rounded-xl border border-gray-800 bg-gray-950 p-5"
            >
              <h3 className="text-lg font-bold text-red-400">
                MY SUBSCRIPTION
              </h3>

              {account.subscription ? (
                <div className="mt-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-lg font-bold">
                        {account.subscription.plan}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Subscription plan
                      </p>
                    </div>

                    <StatusBadge
                      status={
                        activeSubscription
                          ? "ACTIVE"
                          : account.subscription.status === "ACTIVE"
                            ? "EXPIRED"
                            : account.subscription.status
                      }
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-xs text-gray-500">Start Date</p>
                      <p className="mt-1">
                        {formatDate(account.subscription.startsAt)}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-gray-500">Expiry Date</p>
                      <p className="mt-1">
                        {formatDate(account.subscription.expiresAt)}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-gray-400">
                  You don't currently have a subscription record.
                </p>
              )}
            </section>

            <section
              id="usage"
              className="scroll-mt-6 rounded-xl border border-gray-800 bg-gray-950 p-5"
            >
              <h3 className="text-lg font-bold text-red-400">
                USAGE STATISTICS
              </h3>

              <p className="mt-3 text-sm leading-6 text-gray-400">
                Usage tracking has not been configured yet.
                Your actual usage statistics will appear here
                once tracking is implemented.
              </p>
            </section>

            <section
              id="billing"
              className="scroll-mt-6 rounded-xl border border-gray-800 bg-gray-950 p-5"
            >
              <h3 className="text-lg font-bold text-red-400">
                BILLING HISTORY
              </h3>

              {account.payments.length === 0 ? (
                <p className="mt-4 text-sm text-gray-400">
                  No payment records found.
                </p>
              ) : (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[600px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-500">
                        <th className="p-3">Reference</th>
                        <th className="p-3">Amount</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Date</th>
                      </tr>
                    </thead>

                    <tbody>
                      {account.payments.map((payment) => (
                        <tr
                          key={payment.id}
                          className="border-b border-gray-900"
                        >
                          <td className="p-3 break-all">
                            {payment.reference}
                          </td>

                          <td className="p-3">
                            {formatAmount(payment.amount, payment.currency)}
                          </td>

                          <td className="p-3">
                            <StatusBadge status={payment.status} />
                          </td>

                          <td className="p-3">
                            {formatDate(payment.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section
              id="upgrade"
              className="scroll-mt-6 rounded-xl border border-red-900/60 bg-gray-950 p-5"
            >
              <h3 className="font-bold text-red-400">
                UPGRADE PLAN
              </h3>

              <p className="mt-3 text-sm leading-6 text-gray-400">
                Explore subscription options and account upgrades.
                Available plans and payment options will appear here
                once they are configured.
              </p>
            </section>

            <section
              id="support"
              className="scroll-mt-6 rounded-xl border border-gray-800 bg-gray-950 p-5"
            >
              <h3 className="font-bold text-red-400">
                HELP & SUPPORT
              </h3>

              <p className="mt-3 text-sm leading-6 text-gray-400">
                Need assistance with your account, subscription or
                payments? Contact the Evil GPT support team through
                your designated support channel.
              </p>
            </section>

            <section
              id="personalization"
              className="scroll-mt-6 rounded-xl border border-gray-800 bg-gray-950 p-5"
            >
              <h3 className="font-bold text-red-400">
                PERSONALIZATION
              </h3>

              <p className="mt-3 text-sm leading-6 text-gray-400">
                Personalization settings are not available yet.
                Custom preferences will appear here once implemented.
              </p>
            </section>

            <footer className="border-t border-gray-900 py-5 text-center text-xs text-gray-600">
              EVIL GPT CUSTOMER PORTAL
            </footer>

          </div>
        </div>
      </div>
    </main>
  );
}
