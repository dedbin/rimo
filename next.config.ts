import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",  
        hostname: "img.clerk.com", 
      }
    ]
  },
  /* config options here */
  devIndicators: false
};

export default nextConfig;
