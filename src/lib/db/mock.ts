/**
 * 进程内 mock 数据 —— 仅在 Supabase env 缺失时使用
 * 特点：每次 dev server 重启就清空
 */
import type { Activity, NewActivity } from "@/types/db";

const _store: Activity[] = [
  { id: "m1", title: "周末飞盘局（mock）", starts_at: "2026-06-13T14:00:00+08:00", location: "朝阳公园", capacity: 10, host_name: "阿飞", created_at: "2026-06-09T20:00:00+08:00" },
  { id: "m2", title: "咖啡读书会（mock）", starts_at: "2026-06-15T10:00:00+08:00", location: "国贸",     capacity: 6,  host_name: "小满", created_at: "2026-06-09T20:00:00+08:00" },
  { id: "m3", title: "夜跑 5km（mock）",   starts_at: "2026-06-11T20:00:00+08:00", location: "奥森南门", capacity: 12, host_name: "Tony", created_at: "2026-06-09T20:00:00+08:00" },
];

let _idSeq = 100;

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
