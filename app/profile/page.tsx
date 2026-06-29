"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearSession,
  fetchCurrentUser,
  fetchProfile,
  getStoredSession,
  Profile,
  saveProfile,
  SupabaseSession
} from "../lib/supabase";

const emptyProfile: Profile = {
  user_id: "",
  nickname: "",
  avatar_url: "",
  gender: "",
  birth_year: null,
  city: "",
  district: "",
  bio: "",
  interests: []
};

export default function ProfilePage() {
  const router = useRouter();
  const [session, setSession] = useState<SupabaseSession | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [interestsText, setInterestsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const email = useMemo(() => session?.user.email ?? "已登录用户", [session]);

  useEffect(() => {
    async function loadProfile() {
      const stored = getStoredSession();
      if (!stored) {
        router.replace(`/login?next=${encodeURIComponent("/profile")}`);
        return;
      }

      try {
        const currentSession = stored.user.id ? stored : await fetchCurrentUser(stored);
        setSession(currentSession);
        const row = await fetchProfile(currentSession);
        const nextProfile = {
          ...emptyProfile,
          ...(row ?? {}),
          user_id: currentSession.user.id
        };
        setProfile(nextProfile);
        setInterestsText((nextProfile.interests ?? []).join("、"));
      } catch (err) {
        setError(err instanceof Error ? err.message : "资料加载失败");
      } finally {
        setLoading(false);
      }
    }

    void loadProfile();
  }, [router]);

  function updateField<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const saved = await saveProfile(session, {
        ...profile,
        user_id: session.user.id,
        birth_year: profile.birth_year ? Number(profile.birth_year) : null,
        interests: interestsText
          .split(/[、,\s]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      });
      setProfile(saved);
      setInterestsText((saved.interests ?? []).join("、"));
      setMessage("个人资料已保存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function handleLogout() {
    clearSession();
    router.replace("/login");
  }

  if (loading) {
    return (
      <main>
        <header className="site-header">
          <a className="brand" href="/">
            同城搭子
          </a>
        </header>
        <section className="section">正在加载个人资料...</section>
      </main>
    );
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/">
          同城搭子
        </a>
        <nav className="nav-links" aria-label="资料页导航">
          <a href="/">首页</a>
          <button className="nav-button" onClick={handleLogout} type="button">
            退出登录
          </button>
        </nav>
      </header>

      <section className="profile-shell">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Profile</p>
            <h1>个人资料</h1>
          </div>
          <p className="profile-email">{email}</p>
        </div>

        <form className="profile-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              昵称
              <input
                onChange={(event) => updateField("nickname", event.target.value)}
                placeholder="怎么称呼你"
                value={profile.nickname ?? ""}
              />
            </label>
            <label>
              头像 URL
              <input
                onChange={(event) => updateField("avatar_url", event.target.value)}
                placeholder="https://..."
                value={profile.avatar_url ?? ""}
              />
            </label>
            <label>
              性别
              <select
                onChange={(event) => updateField("gender", event.target.value)}
                value={profile.gender ?? ""}
              >
                <option value="">不展示</option>
                <option value="female">女</option>
                <option value="male">男</option>
                <option value="nonbinary">非二元</option>
                <option value="prefer_not_to_say">不想透露</option>
              </select>
            </label>
            <label>
              出生年份
              <input
                max="2026"
                min="1900"
                onChange={(event) =>
                  updateField("birth_year", event.target.value ? Number(event.target.value) : null)
                }
                placeholder="1998"
                type="number"
                value={profile.birth_year ?? ""}
              />
            </label>
            <label>
              城市
              <input
                onChange={(event) => updateField("city", event.target.value)}
                placeholder="上海"
                value={profile.city ?? ""}
              />
            </label>
            <label>
              区县
              <input
                onChange={(event) => updateField("district", event.target.value)}
                placeholder="徐汇"
                value={profile.district ?? ""}
              />
            </label>
          </div>

          <label>
            兴趣
            <input
              onChange={(event) => setInterestsText(event.target.value)}
              placeholder="饭搭子、运动、看展"
              value={interestsText}
            />
          </label>

          <label>
            简介
            <textarea
              onChange={(event) => updateField("bio", event.target.value)}
              placeholder="说说你想找什么样的同城搭子"
              rows={5}
              value={profile.bio ?? ""}
            />
          </label>

          <button disabled={saving} type="submit">
            {saving ? "保存中..." : "保存资料"}
          </button>
          {message ? <p className="form-message">{message}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </form>
      </section>
    </main>
  );
}
