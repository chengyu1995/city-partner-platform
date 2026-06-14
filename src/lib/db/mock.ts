/**
 * 进程内 mock 数据 —— 仅在 Supabase env 缺失时使用
 * 特点：每次 dev server 重启就清空
 */
import type { Activity, NewActivity, PartnerPost, NewPartnerPost, PartnerCategory } from "@/types/db";

const _store: Activity[] = [
  { id: "m1", title: "周末飞盘局（mock）", starts_at: "2026-06-13T14:00:00+08:00", location: "朝阳公园", capacity: 10, host_name: "阿飞", created_at: "2026-06-09T20:00:00+08:00" },
  { id: "m2", title: "咖啡读书会（mock）", starts_at: "2026-06-15T10:00:00+08:00", location: "国贸",     capacity: 6,  host_name: "小满", created_at: "2026-06-09T20:00:00+08:00" },
  { id: "m3", title: "夜跑 5km（mock）",   starts_at: "2026-06-11T20:00:00+08:00", location: "奥森南门", capacity: 12, host_name: "Tony", created_at: "2026-06-09T20:00:00+08:00" },
];

const _partnerStore: PartnerPost[] = [
  { id: "p1", category: "旅游", city: "北京", title: "周末去阿那亚看海", description: "想找个搭子周末一起去看海拍照", contact: "wx: alice_99", host_name: "小爱", starts_at: "2026-06-20T09:00:00+08:00", created_at: "2026-06-10T10:00:00+08:00", status: "approved" },
  { id: "p2", category: "K歌", city: "上海", title: "周五下班唱歌", description: "人民广场附近 KTV，找 2-3 个朋友一起", contact: "13800001111", host_name: "阿凯", starts_at: "2026-06-19T19:30:00+08:00", created_at: "2026-06-10T11:00:00+08:00", status: "approved" },
];

let _idSeq = 100;
let _partnerIdSeq = 100;

export function listActivitiesMock(): Promise<Activity[]> {
  return Promise.resolve([..._store].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
}

export function getActivityMock(id: string): Promise<Activity | null> {
  return Promise.resolve(_store.find((a) => a.id === id) ?? null);
}

export function createActivityMock(input: NewActivity): Promise<Activity> {
  const row: Activity = {
    id: `m${++_idSeq}`,
    created_at: new Date().toISOString(),
    ...input,
  };
  _store.push(row);
  return Promise.resolve(row);
}

/* ============================================================
 * partner_posts mock
 * ========================================================== */

export function listPartnerPostsMock(opts?: { category?: PartnerCategory; city?: string; status?: "pending" | "approved" | "rejected" }): Promise<PartnerPost[]> {
  let rows = [..._partnerStore];
  if (opts?.category) rows = rows.filter((r) => r.category === opts.category);
  if (opts?.city) rows = rows.filter((r) => r.city.includes(opts.city!));
  if (opts?.status) rows = rows.filter((r) => r.status === opts.status);
  return Promise.resolve(rows.sort((a, b) => b.created_at.localeCompare(a.created_at)));
}

export function getPartnerPostMock(id: string): Promise<PartnerPost | null> {
  return Promise.resolve(_partnerStore.find((p) => p.id === id) ?? null);
}

export function createPartnerPostMock(input: NewPartnerPost): Promise<PartnerPost> {
  // mock 模式默认 approved (真实模式走审核, status=pending)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { status: _ignored, ...rest } = input as any;
  const row: PartnerPost = {
    id: `p${++_partnerIdSeq}`,
    created_at: new Date().toISOString(),
    status: "approved",
    ...rest,
  };
  _partnerStore.unshift(row);
  return Promise.resolve(row);
}
