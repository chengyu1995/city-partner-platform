"use client";

/**
 * Dark mode 切换按钮
 * - 客户端组件 (use client) - 用 localStorage + DOM 操作
 * - 用 lucide-react 现有的 Sun/Moon 图标
 * - 持久化到 localStorage (key: theme)
 * - 防 FOUC: layout.tsx 里有 inline script 在 hydration 前设 class
 *
 * 跟 AGENTS.md 13 条规则保持一致:
 * - 用现有依赖 (lucide-react, Button 组件)
 * - 不改基础设施
 * - 不用 inline email/secret
 */
import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

type Theme = "light" | "dark";

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

// 用 useSyncExternalStore 订阅 <html> 上的 dark class 变化
// 这样 setState 不在 effect 里, 也不需要 mounted flag
function subscribeToTheme(callback: () => void) {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return readInitialTheme();
}

function getServerSnapshot(): Theme {
  return "light";
}

export function ThemeToggle() {
  const theme = React.useSyncExternalStore(
    subscribeToTheme,
    getSnapshot,
    getServerSnapshot
  );

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    if (next === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage 不可用 (隐私模式) - 静默忽略
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={theme === "dark" ? "切换到亮色" : "切换到暗色"}
      className="h-9 w-9"
      onClick={toggleTheme}
    >
      {theme === "dark" ? (
        <Sun className="h-5 w-5" />
      ) : (
        <Moon className="h-5 w-5" />
      )}
    </Button>
  );
}
