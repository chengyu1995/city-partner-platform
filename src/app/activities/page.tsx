import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// TODO: 接入 Supabase 后从 server-side fetch
const MOCK = [
  { id: "1", title: "周末飞盘局", when: "周六 14:00", where: "朝阳公园", people: "6/10" },
  { id: "2", title: "咖啡读书会", when: "周日 10:00", where: "国贸", people: "3/6" },
  { id: "3", title: "夜跑 5km", when: "周三 20:00", where: "奥森南门", people: "8/12" },
];

export default function ActivitiesPage() {
  return (
    <main className="container py-10">
      <h1 className="mb-6 text-3xl font-bold">活动列表</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MOCK.map((a) => (
          <Card key={a.id}>
            <CardHeader>
              <CardTitle>{a.title}</CardTitle>
              <CardDescription>{a.when} · {a.where}</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">已报名 {a.people}</p>
              <Button size="sm">报名</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
