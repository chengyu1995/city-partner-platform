export const LOCAL_DRAFTS_STORAGE_KEY = "city_partner_local_drafts";

export type LocalPostDraftStatus = "draft" | "pending_review";

export type LocalPostDraft = {
  id: string;
  city: string;
  category: string;
  title: string;
  activityTime: string;
  expectedPeople: string;
  description: string;
  contactNote: string;
  status: LocalPostDraftStatus;
  createdAt: string;
};

export type LocalPostDraftInput = Omit<LocalPostDraft, "id" | "status" | "createdAt">;

const LOCAL_DRAFTS_EVENT = "city-partner-local-drafts-change";
const EMPTY_DRAFTS: LocalPostDraft[] = [];
let cachedRawDrafts: string | null = null;
let cachedDrafts: LocalPostDraft[] = EMPTY_DRAFTS;

function canUseLocalStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isLocalPostDraft(value: unknown): value is LocalPostDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<Record<keyof LocalPostDraft, unknown>>;

  return (
    typeof draft.id === "string" &&
    typeof draft.city === "string" &&
    typeof draft.category === "string" &&
    typeof draft.title === "string" &&
    typeof draft.activityTime === "string" &&
    typeof draft.expectedPeople === "string" &&
    typeof draft.description === "string" &&
    typeof draft.contactNote === "string" &&
    (draft.status === "draft" || draft.status === "pending_review") &&
    typeof draft.createdAt === "string"
  );
}

function emitLocalDraftsChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LOCAL_DRAFTS_EVENT));
}

function createDraftId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createLocalPostDraft(input: LocalPostDraftInput): LocalPostDraft {
  return {
    ...input,
    id: createDraftId(),
    status: "pending_review",
    createdAt: new Date().toISOString(),
  };
}

export function readLocalPostDrafts(): LocalPostDraft[] {
  if (!canUseLocalStorage()) return EMPTY_DRAFTS;

  try {
    const raw = window.localStorage.getItem(LOCAL_DRAFTS_STORAGE_KEY);
    if (!raw) {
      cachedRawDrafts = null;
      cachedDrafts = EMPTY_DRAFTS;
      return cachedDrafts;
    }

    if (raw === cachedRawDrafts) return cachedDrafts;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      cachedRawDrafts = raw;
      cachedDrafts = EMPTY_DRAFTS;
      return cachedDrafts;
    }

    cachedRawDrafts = raw;
    cachedDrafts = parsed.filter(isLocalPostDraft);
    return cachedDrafts;
  } catch {
    return EMPTY_DRAFTS;
  }
}

export function saveLocalPostDraft(draft: LocalPostDraft) {
  if (!canUseLocalStorage()) return false;

  try {
    const drafts = readLocalPostDrafts();
    const nextDrafts = [draft, ...drafts.filter((item) => item.id !== draft.id)];
    window.localStorage.setItem(LOCAL_DRAFTS_STORAGE_KEY, JSON.stringify(nextDrafts));
    emitLocalDraftsChange();
    return true;
  } catch {
    return false;
  }
}

export function clearLocalPostDrafts() {
  if (!canUseLocalStorage()) return false;

  try {
    window.localStorage.removeItem(LOCAL_DRAFTS_STORAGE_KEY);
    emitLocalDraftsChange();
    return true;
  } catch {
    return false;
  }
}

export function subscribeLocalPostDrafts(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  window.addEventListener(LOCAL_DRAFTS_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);

  return () => {
    window.removeEventListener(LOCAL_DRAFTS_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export function getLocalPostDraftsSnapshot() {
  return readLocalPostDrafts();
}

export function getLocalPostDraftsServerSnapshot() {
  return EMPTY_DRAFTS;
}
