"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  consumeHashSession,
  fetchCurrentUser,
  getStoredSession,
  sendLoginCode,
  verifyLoginCode
} from "../lib/supabase";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/profile";
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function finishHashLogin() {
      const session = consumeHashSession();
      if (!session) {
        return;
      }

      try {
        await fetchCurrentUser(session);
        router.replace(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "登录状态确认失败");
      }
    }

    if (getStoredSession()) {
      router.replace(next);
      return;
    }

    void finishHashLogin();
  }, [next, router]);

  async function handleSendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      await sendLoginCode(email.trim());
      setStep("code");
      setMessage("验证码已发送，请查看邮箱。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码发送失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const session = await verifyLoginCode(email.trim(), token.trim());
      await fetchCurrentUser(session);
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码校验失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header className="site-header">
        <Link className="brand" href="/">
          同城搭子
        </Link>
        <nav className="nav-links" aria-label="登录导航">
          <Link href="/">返回首页</Link>
          <Link href="/profile">个人资料</Link>
        </nav>
      </header>

      <section className="auth-shell">
        <div className="auth-copy">
          <p className="eyebrow">Email Login</p>
          <h1>用邮箱验证码登录</h1>
          <p>登录后可以发布搭子帖、维护个人资料，并查看自己的申请进度。</p>
        </div>

        <div className="auth-panel">
          {step === "email" ? (
            <form onSubmit={handleSendCode}>
              <label htmlFor="email">邮箱</label>
              <input
                id="email"
                autoComplete="email"
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                type="email"
                value={email}
              />
              <button disabled={loading} type="submit">
                {loading ? "发送中..." : "发送验证码"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyCode}>
              <label htmlFor="code">邮箱验证码</label>
              <input
                id="code"
                autoComplete="one-time-code"
                onChange={(event) => setToken(event.target.value)}
                placeholder="输入 6 位验证码"
                required
                value={token}
              />
              <button disabled={loading} type="submit">
                {loading ? "登录中..." : "登录"}
              </button>
              <button className="text-button" onClick={() => setStep("email")} type="button">
                换一个邮箱
              </button>
            </form>
          )}
          {message ? <p className="form-message">{message}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
