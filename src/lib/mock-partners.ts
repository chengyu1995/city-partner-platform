export const partnerCities = ["惠州", "广州", "深圳", "上海"] as const;

export const partnerCategories = [
  { name: "饭搭子", desc: "约饭、探店、下班吃点好的" },
  { name: "运动搭子", desc: "跑步、羽毛球、健身、球类" },
  { name: "学习搭子", desc: "自习、备考、读书、技能学习" },
  { name: "出游搭子", desc: "周边游、城市散步、短途旅行" },
  { name: "K 歌搭子", desc: "KTV、清吧唱歌、练歌" },
  { name: "摩友搭子", desc: "骑行、路线、短途摩旅" },
  { name: "钓友搭子", desc: "野钓、黑坑、周末钓鱼" },
] as const;

export type MockPartnerStatus = "pending_review";

export type MockPartnerPost = {
  id: string;
  city: string;
  category: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  capacity: string;
  description: string;
  targetPeople: string;
  budgetNote: string;
  notes: string;
  hostName: string;
  status: MockPartnerStatus;
  createdAt: string;
};

export const mockPartnerPosts: MockPartnerPost[] = [
  {
    id: "mock-huizhou-citywalk",
    city: "惠州",
    category: "出游搭子",
    title: "周末惠州西湖 Citywalk",
    startsAt: "周日 10:00",
    endsAt: "周日 16:00",
    location: "惠州西湖东门集合",
    capacity: "2-5 人",
    description: "轻松散步拍照，中午附近吃饭，节奏慢一点。",
    targetPeople: "喜欢走路拍照，新手友好",
    budgetNote: "AA，预计人均 80 元内",
    notes: "遇到下雨就改期",
    hostName: "阿城",
    status: "pending_review",
    createdAt: "2026-07-05T10:00:00.000Z",
  },
  {
    id: "mock-guangzhou-hotpot",
    city: "广州",
    category: "饭搭子",
    title: "下班后一起吃潮汕牛肉火锅",
    startsAt: "周五 19:30",
    endsAt: "",
    location: "体育西路附近",
    capacity: "3 人",
    description: "想找附近下班后的饭搭子，吃完可以顺路散步。",
    targetPeople: "不赶时间，能接受 AA",
    budgetNote: "AA，约 100 元/人",
    notes: "不拼酒",
    hostName: "小林",
    status: "pending_review",
    createdAt: "2026-07-05T11:00:00.000Z",
  },
  {
    id: "mock-shenzhen-badminton",
    city: "深圳",
    category: "运动搭子",
    title: "周六下午找羽毛球搭子",
    startsAt: "周六 15:00",
    endsAt: "周六 17:00",
    location: "南山科技园附近球馆",
    capacity: "2-4 人",
    description: "休闲局，不卷水平，主要动一动出汗。",
    targetPeople: "能打基础回合即可",
    budgetNote: "场地费 AA",
    notes: "请自带球拍",
    hostName: "Leo",
    status: "pending_review",
    createdAt: "2026-07-05T12:00:00.000Z",
  },
  {
    id: "mock-shanghai-study",
    city: "上海",
    category: "学习搭子",
    title: "晚上自习搭子，互相监督",
    startsAt: "工作日 19:30",
    endsAt: "工作日 22:00",
    location: "徐家汇附近自习室",
    capacity: "2 人",
    description: "备考和技能学习都可以，安静学习，结束简单复盘。",
    targetPeople: "想稳定学习的人",
    budgetNote: "自习室费用自理",
    notes: "不闲聊打扰",
    hostName: "Mia",
    status: "pending_review",
    createdAt: "2026-07-05T13:00:00.000Z",
  },
];

export const partnerStatusText: Record<MockPartnerStatus, string> = {
  pending_review: "待审核",
};
