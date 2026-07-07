import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "找搭子 - 同城搭子平台",
  description: "按惠州、广州、深圳、上海和首批七个分类浏览同城搭子需求。访客可以直接浏览。",
  keywords: ["搭子列表", "同城", "兴趣社交", "饭搭子", "运动搭子", "出游搭子"],
  openGraph: {
    title: "找搭子 - 同城搭子平台",
    description: "按城市、分类浏览同城搭子帖",
    type: "website",
    locale: "zh_CN",
  },
};

export default function PartnersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
