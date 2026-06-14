import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "找搭子 - 同城搭子平台",
  description: "按城市、分类浏览同城搭子帖。旅游、K 歌、学习、摩友、钓友应有尽有。",
  keywords: ["搭子列表", "同城", "兴趣社交"],
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
