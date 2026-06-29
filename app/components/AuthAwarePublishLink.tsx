"use client";

import { MouseEvent } from "react";
import { hasSession } from "../lib/supabase";

type AuthAwarePublishLinkProps = {
  className?: string;
  children: React.ReactNode;
};

export function AuthAwarePublishLink({ className, children }: AuthAwarePublishLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (hasSession()) {
      return;
    }

    event.preventDefault();
    window.location.href = `/login?next=${encodeURIComponent("/profile")}`;
  }

  return (
    <a className={className} href="#publish-form" onClick={handleClick}>
      {children}
    </a>
  );
}
