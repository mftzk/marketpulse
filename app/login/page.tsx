"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { COPY } from "@/lib/copy";

const inputClass =
  "w-full border border-hairline bg-panel-alt px-3 py-2 text-sm text-ink outline-none focus:border-accent";

function safeNext(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }
  return "/";
}

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("trader@marketpulse.dev");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(json.error ?? COPY.auth.errorGeneric);
        return;
      }
      const target = safeNext(params.get("next"));
      // Hard navigation on purpose. The App Router's client-side cache can still hold the
      // pre-login response for `target` (the middleware had bounced it to /login), so
      // `router.replace(target)` replays that cached redirect and the user stays stuck on
      // the login page. A full document load guarantees the session cookie is sent.
      window.location.assign(target);
    } catch {
      setError(COPY.auth.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 w-full max-w-sm space-y-3">
      <div className="border border-hairline bg-panel p-5">
        <h1 className="text-sm font-semibold text-ink">{COPY.auth.title}</h1>
        <p className="mt-1 text-[11px] text-muted">{COPY.auth.subtitle}</p>

        <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted">
              {COPY.auth.email}
            </span>
            <input
              type="email"
              autoComplete="username"
              className={inputClass}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted">
              {COPY.auth.password}
            </span>
            <input
              type="password"
              autoComplete="current-password"
              className={inputClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? <p className="text-[11px] text-negative">{error}</p> : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full border border-accent px-3 py-2 text-xs uppercase tracking-wide text-accent disabled:opacity-50"
          >
            {busy ? COPY.common.loading : COPY.auth.signIn}
          </button>
        </form>
      </div>

      <div className="border border-hairline bg-panel-alt p-3">
        <p className="text-[10px] uppercase tracking-[0.14em] text-muted">{COPY.auth.demoHint}</p>
        <p className="mt-1 font-mono text-[11px] text-ink">{COPY.auth.demoCredentials}</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto mt-16 w-full max-w-sm border border-hairline bg-panel p-5 text-xs text-muted">
          {COPY.common.loading}
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
