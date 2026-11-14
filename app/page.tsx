
import Link from "next/link";

const features = [
  {
    number: "01",
    title: "INTELLIGENT REASONING",
    description:
      "Explore complex ideas, solve problems and challenge conventional thinking.",
  },
  {
    number: "02",
    title: "CODE WITHOUT FEAR",
    description:
      "Debug errors, understand programming and build ambitious projects.",
  },
  {
    number: "03",
    title: "PERSISTENT MEMORY",
    description:
      "Continue conversations with context from your previous interactions.",
  },
];

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#030303] text-white">

      {/* Background effects */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 top-20 h-96 w-96 rounded-full bg-red-950/30 blur-[130px]" />
        <div className="absolute -right-40 top-96 h-96 w-96 rounded-full bg-red-900/20 blur-[140px]" />

        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,0,0,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(255,0,0,0.3) 1px, transparent 1px)",
            backgroundSize: "55px 55px",
          }}
        />
      </div>

      {/* Navigation */}
      <nav className="relative z-10 flex items-center justify-between border-b border-red-950/70 bg-black/60 px-6 py-5 backdrop-blur-xl md:px-12">
        <Link href="/" className="group">
          <h1 className="text-2xl font-black tracking-[0.2em] text-red-600 transition group-hover:text-red-400">
            EVIL<span className="text-white">GPT</span>
          </h1>
          <p className="text-[9px] tracking-[0.35em] text-gray-600">
            BEYOND ORDINARY INTELLIGENCE
          </p>
        </Link>

        <div className="flex items-center gap-3">
          <Link
            href="/register"
            className="border border-gray-800 px-5 py-2.5 text-xs font-bold tracking-widest text-gray-300 transition hover:border-red-600 hover:text-white"
          >
            CREATE ACCOUNT
          </Link>

          <Link
            href="/login"
            className="border border-red-800 px-6 py-2.5 text-xs font-bold tracking-widest text-red-400 transition duration-300 hover:border-red-500 hover:bg-red-950/50 hover:text-white"
          >
            ACCESS SYSTEM
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 mx-auto flex min-h-[650px] max-w-7xl flex-col items-center justify-center px-6 py-24 text-center">

        <div className="mb-8 flex items-center gap-3 border border-red-900/50 bg-red-950/20 px-5 py-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500 shadow-[0_0_12px_#ff0000]" />
          <span className="text-[10px] font-bold tracking-[0.3em] text-red-400">
            THE SYSTEM IS AWAKE
          </span>
        </div>

        <p className="mb-6 text-xs font-semibold tracking-[0.5em] text-gray-600">
          WELCOME TO THE DARK SIDE
        </p>

        <h2 className="text-6xl font-black leading-[0.95] tracking-tight sm:text-7xl md:text-9xl">
          <span className="block text-white drop-shadow-[0_0_25px_rgba(255,0,0,0.15)]">
            THINK
          </span>

          <span className="block bg-gradient-to-r from-red-800 via-red-500 to-red-900 bg-clip-text text-transparent drop-shadow-[0_0_35px_rgba(255,0,0,0.3)]">
            WITHOUT
          </span>

          <span className="block text-white">
            LIMITS.
          </span>
        </h2>

        <p className="mt-9 max-w-2xl text-base leading-8 text-gray-400 md:text-lg">
          An AI built to explore ideas, challenge problems and push
          the boundaries of intelligent conversation.
          <span className="text-red-500"> Your next move starts here.</span>
        </p>

        <div className="mt-12 flex w-full flex-col justify-center gap-4 sm:w-auto sm:flex-row">

          <Link
            href="/login"
            className="group relative overflow-hidden border border-red-600 bg-red-700 px-10 py-4 text-sm font-black tracking-[0.2em] text-white shadow-[0_0_30px_rgba(180,0,0,0.25)] transition duration-300 hover:bg-red-600 hover:shadow-[0_0_45px_rgba(255,0,0,0.4)]"
          >
            ENTER THE SYSTEM
          </Link>

          <Link
            href="/register"
            className="border border-red-900 bg-red-950/20 px-10 py-4 text-sm font-bold tracking-[0.2em] text-red-400 transition duration-300 hover:border-red-600 hover:bg-red-950/50 hover:text-white"
          >
            CREATE ACCOUNT
          </Link>

          <a
            href="#features"
            className="border border-gray-800 bg-black/50 px-10 py-4 text-sm font-bold tracking-[0.2em] text-gray-400 transition duration-300 hover:border-red-800 hover:text-white"
          >
            EXPLORE CAPABILITIES
          </a>
        </div>

        {/* System panel */}
        <div className="mt-20 w-full max-w-xl border border-red-950/70 bg-[#080808]/90 p-5 text-left shadow-[0_0_60px_rgba(100,0,0,0.08)]">
          <div className="mb-5 flex items-center justify-between border-b border-gray-900 pb-3">
            <span className="text-[10px] font-bold tracking-[0.25em] text-red-500">
              SYSTEM TERMINAL
            </span>
            <span className="text-[9px] tracking-widest text-green-500">
              ● ONLINE
            </span>
          </div>

          <div className="space-y-3 font-mono text-xs">
            <p className="text-gray-600">
              &gt; Initializing intelligence engine...
            </p>
            <p className="text-gray-500">
              &gt; Loading conversation architecture...
            </p>
            <p className="text-red-500">
              &gt; EVIL GPT AWAITS YOUR COMMAND.
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section
        id="features"
        className="relative z-10 border-t border-red-950/60 bg-[#060606] px-6 py-24 md:px-12"
      >
        <div className="mx-auto max-w-7xl">

          <div className="mb-14">
            <p className="mb-4 text-xs font-bold tracking-[0.4em] text-red-600">
              THE ARCHITECTURE
            </p>

            <h3 className="text-3xl font-black tracking-tight md:text-5xl">
              BUILT DIFFERENT.
              <span className="text-red-600"> THINK DIFFERENT.</span>
            </h3>

            <p className="mt-4 max-w-xl text-sm leading-7 text-gray-500">
              Powerful AI capabilities designed for curious minds,
              developers and people who refuse to stop learning.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.number}
                className="group border border-gray-900 bg-[#0b0b0b] p-8 transition duration-300 hover:-translate-y-2 hover:border-red-800 hover:shadow-[0_10px_40px_rgba(150,0,0,0.12)]"
              >
                <span className="text-sm font-black tracking-widest text-red-700">
                  [{feature.number}]
                </span>

                <h4 className="mb-4 mt-8 text-lg font-black tracking-wide text-gray-200 transition group-hover:text-red-500">
                  {feature.title}
                </h4>

                <p className="text-sm leading-7 text-gray-500">
                  {feature.description}
                </p>

                <div className="mt-8 h-[2px] w-10 bg-red-800 transition-all duration-300 group-hover:w-full" />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative z-10 px-6 py-24 text-center">
        <p className="mb-5 text-xs font-bold tracking-[0.4em] text-red-600">
          YOUR SESSION BEGINS HERE
        </p>

        <h3 className="text-4xl font-black md:text-6xl">
          ARE YOU READY?
        </h3>

        <div className="mt-10 flex flex-col justify-center gap-4 sm:flex-row">
          <Link
            href="/register"
            className="inline-block border border-red-600 bg-red-700 px-10 py-4 text-sm font-black tracking-[0.25em] text-white transition hover:bg-red-600"
          >
            CREATE ACCOUNT
          </Link>

          <Link
            href="/login"
            className="inline-block border border-red-600 bg-red-950/30 px-10 py-4 text-sm font-black tracking-[0.25em] text-red-400 transition hover:bg-red-700 hover:text-white"
          >
            INITIALIZE EVIL GPT
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-red-950/60 px-6 py-8 text-center">
        <p className="text-xs font-bold tracking-[0.3em] text-gray-600">
          EVIL GPT © 2026
        </p>
        <p className="mt-2 text-[10px] tracking-widest text-gray-800">
          INTELLIGENCE HAS A NEW IDENTITY.
        </p>
      </footer>
    </main>
  );
}
