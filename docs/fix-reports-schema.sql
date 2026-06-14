-- ============================================================
-- 给 reports 表加 contact 列
-- 路径: Supabase Dashboard → SQL Editor → New query → 粘进去 → Run
-- ============================================================

alter table public.reports
  add column if not exists contact text;

-- 可选: 给 contact 加 index, 如果以后要按举报人联系查
create index if not exists reports_contact_idx
  on public.reports (contact)
  where contact is not null;

-- 验证
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'reports'
order by ordinal_position;
