alter table public.reports
  add column if not exists contact text;

create index if not exists reports_contact_idx
  on public.reports (contact)
  where contact is not null;

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'reports'
order by ordinal_position;
