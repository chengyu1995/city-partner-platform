import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloudflare Pages 兼容配置
  // - next/image 默认不优化,避免 Cloudflare 适配问题
  // - 若要启用图片优化,需装 @cloudflare/next-on-pages 并改 image 域
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
