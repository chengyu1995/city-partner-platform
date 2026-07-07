import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "同城搭子 - 找兴趣相投的同城朋友",
  description: "发布饭搭子、运动搭子、学习搭子、出游搭子、K 歌搭子、摩友搭子、钓友搭子需求。MVP 第一阶段先保存本地草稿或提交待审核。",
  keywords: ["同城", "搭子", "饭搭子", "运动搭子", "学习搭子", "出游搭子", "K歌搭子", "摩友搭子", "钓友搭子", "兴趣社交"],
  openGraph: {
    title: "同城搭子 - 找兴趣相投的同城朋友",
    description: "先保存本地草稿或提交待审核，联系方式展示策略后续单独确认。",
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
