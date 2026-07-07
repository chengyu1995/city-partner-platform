import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "同城搭子 - 找兴趣相投的同城朋友",
  description: "旅游、K 歌、学习、摩友、钓友... 20-35 岁同城兴趣社交平台。几秒钟发个搭子帖, 找兴趣相投的朋友一起玩。",
  keywords: ["同城", "搭子", "旅游搭子", "K歌搭子", "学习搭子", "摩友", "钓友", "兴趣社交"],
  openGraph: {
    title: "同城搭子 - 找兴趣相投的同城朋友",
    description: "20-35 岁同城兴趣社交平台, 旅游/K歌/学习/摩友/钓友",
    type: "website",
    locale: "zh_CN",
  },
  twitter: {
    card: "summary_large_image",
    title: "同城搭子",
    description: "20-35 岁同城兴趣社交平台",
  },
};

export default function PostLayout({ children }: { children: React.ReactNode }) {
  return children;
}
