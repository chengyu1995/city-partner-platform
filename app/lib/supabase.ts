"use client";

export type SupabaseUser = {
  id: string;
  email?: string;
};

export type SupabaseSession = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  user: SupabaseUser;
};

export type Profile = {
  user_id: string;
  nickname: string | null;
  avatar_url: string | null;
  gender: string | null;
  birth_year: number | null;
  city: string | null;
  district: string | null;
  bio: string | null;
  interests: string[] | null;
  created_at?: string;
  updated_at?: string;
};

const sessionKey = "city-partner.supabase-session";

function getConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return {
    anonKey,
    restUrl: `${url.replace(/\/$/, "")}/rest/v1`,
    authUrl: `${url.replace(/\/$/, "")}/auth/v1`
  };
}

function authHeaders(token?: string) {
  const { anonKey } = getConfig();

  return {
    apikey: anonKey,
    Authorization: `Bearer ${token ?? anonKey}`,
    "Content-Type": "application/json"
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `请求失败：${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getStoredSession(): SupabaseSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(sessionKey);
  if (!raw) {
    return null;
  }

  try {
    const session = JSON.parse(raw) as SupabaseSession;
    if (session.expires_at && session.expires_at * 1000 < Date.now()) {
      window.localStorage.removeItem(sessionKey);
      return null;
    }

    return session;
  } catch {
    window.localStorage.removeItem(sessionKey);
    return null;
  }
}

export function storeSession(session: SupabaseSession) {
  window.localStorage.setItem(sessionKey, JSON.stringify(session));
}

export function clearSession() {
  window.localStorage.removeItem(sessionKey);
}

export function hasSession() {
  return Boolean(getStoredSession());
}

export async function sendLoginCode(email: string) {
  const { authUrl } = getConfig();

  const response = await fetch(`${authUrl}/otp`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email,
      should_create_user: true,
      options: {
        email_redirect_to: `${window.location.origin}/login`
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "验证码发送失败");
  }
}

export async function verifyLoginCode(email: string, token: string) {
  const { authUrl } = getConfig();

  const response = await fetch(`${authUrl}/verify`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email,
      token,
      type: "email"
    })
  });

  const session = await readJson<SupabaseSession>(response);
  storeSession(session);
  return session;
}

export function consumeHashSession() {
  if (typeof window === "undefined" || !window.location.hash) {
    return null;
  }

  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token") ?? undefined;
  const expiresIn = Number(params.get("expires_in") ?? "0");

  if (!accessToken) {
    return null;
  }

  const session: SupabaseSession = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
    user: {
      id: params.get("user_id") ?? ""
    }
  };

  storeSession(session);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return session;
}

export async function fetchCurrentUser(session: SupabaseSession) {
  const { authUrl } = getConfig();
  const response = await fetch(`${authUrl}/user`, {
    headers: authHeaders(session.access_token)
  });

  const user = await readJson<SupabaseUser>(response);
  const nextSession = { ...session, user };
  storeSession(nextSession);
  return nextSession;
}

export async function fetchProfile(session: SupabaseSession) {
  const { restUrl } = getConfig();
  const response = await fetch(
    `${restUrl}/profiles?user_id=eq.${encodeURIComponent(session.user.id)}&select=*`,
    {
      headers: authHeaders(session.access_token)
    }
  );

  const rows = await readJson<Profile[]>(response);
  return rows[0] ?? null;
}

export async function saveProfile(session: SupabaseSession, profile: Profile) {
  const { restUrl } = getConfig();
  const response = await fetch(`${restUrl}/profiles?on_conflict=user_id`, {
    method: "POST",
    headers: {
      ...authHeaders(session.access_token),
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(profile)
  });

  const rows = await readJson<Profile[]>(response);
  return rows[0];
}
